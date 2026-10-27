import { ChannelType, RateLimitError } from 'discord.js';
import { channelName, ticketNumber } from './catalog.js';
import { isUnknownChannel } from './errors.js';

const slot = (ticket) => `${ticket.ownerId}:${ticket.type}`;

// Le bot ne fait des PATCH de salon que pour les noms ; renvoyer les limites au
// synchroniseur au lieu de laisser discord.js attendre silencieusement plusieurs minutes.
export function rejectChannelRenameRateLimit({ route, method }) {
  return route === '/channels/:id' && String(method).toUpperCase() === 'PATCH';
}

// Une seule requête de renommage à la fois par salon. Les modifications de statut
// ne l'attendent pas : si Discord impose un délai, seule la dernière est rejouée.
export class ChannelNameSynchronizer {
  constructor({ store, locks, guildId, logger = console, onSynced = async () => {} }) {
    this.store = store;
    this.locks = locks;
    this.guildId = guildId;
    this.logger = logger;
    this.onSynced = onSynced;
    this.jobs = new Map();
  }

  schedule(guild, channelId, { retryNow = false } = {}) {
    const ticket = this.store.get(channelId);
    if (!ticket || ticket.status === 'deleted' || !ticket.renamePending) return;
    if (guild.id !== this.guildId) throw new Error('Serveur incorrect pour la synchronisation du nom.');
    const existing = this.jobs.get(channelId);
    if (existing) {
      // Une réparation manuelle peut relancer une erreur réseau, mais ne doit
      // jamais contourner le délai imposé par Discord pour un rate limit.
      if (retryNow && existing.timer && existing.retryReason !== 'rate-limit') {
        clearTimeout(existing.timer);
        existing.timer = null;
        queueMicrotask(() => { void this.#run(existing); });
      }
      return;
    }
    const job = { guild, channelId, key: slot(ticket), timer: null, cancelled: false, failures: 0 };
    this.jobs.set(channelId, job);
    queueMicrotask(() => { void this.#run(job); });
  }

  cancel(channelId) {
    const job = this.jobs.get(channelId);
    if (!job) return;
    job.cancelled = true;
    if (job.timer) clearTimeout(job.timer);
    this.jobs.delete(channelId);
  }

  stop() {
    for (const channelId of [...this.jobs.keys()]) this.cancel(channelId);
  }

  #later(job, milliseconds, reason = 'error') {
    if (job.cancelled || this.jobs.get(job.channelId) !== job) return;
    job.retryReason = reason;
    job.timer = setTimeout(() => {
      job.timer = null;
      job.retryReason = null;
      void this.#run(job);
    }, milliseconds);
    // Un délai de renommage ne doit pas empêcher l'arrêt du processus.
    job.timer.unref?.();
  }

  async #markMissing(job) {
    await this.locks.run(job.key, () => {
      if (job.cancelled) return;
      this.store.markDeleted(job.channelId);
      this.cancel(job.channelId);
    });
  }

  async #run(job) {
    if (job.cancelled || this.jobs.get(job.channelId) !== job) return;
    try {
      const ticket = await this.locks.run(job.key, () => {
        const current = this.store.get(job.channelId);
        if (!current || current.status === 'deleted' || !current.renamePending || current.pendingTransition) {
          this.cancel(job.channelId);
          return null;
        }
        return current;
      });
      if (!ticket || job.cancelled) return;
      const target = channelName(ticket);
      let channel;
      try {
        channel = await job.guild.channels.fetch(job.channelId, { force: true });
        if (!channel) {
          await this.#markMissing(job);
          return;
        }
        if (channel.guildId !== this.guildId || channel.type !== ChannelType.GuildText) {
          throw new Error(`Le salon ${job.channelId} n’est pas un salon texte de ce serveur.`);
        }
        if (channel.name !== target) {
          const stillRelevant = await this.locks.run(job.key, () => {
            const latest = this.store.get(job.channelId);
            return !job.cancelled && latest && latest.status !== 'deleted'
              && !latest.pendingTransition && channelName(latest) === target;
          });
          if (!stillRelevant) {
            this.#later(job, 0, 'new-status');
            return;
          }
          await channel.setName(target, `Suivi du ticket #${ticketNumber(ticket.number)}`);
        }
      } catch (error) {
        if (isUnknownChannel(error)) {
          await this.#markMissing(job);
          return;
        }
        if (error instanceof RateLimitError) {
          const delay = Math.max(50, Math.max(Number(error.retryAfter) || 0, Number(error.sublimitTimeout) || 0) + 250);
          this.logger.warn?.(`Renommage du ticket #${ticketNumber(ticket.number)} différé par Discord (${Math.ceil(delay / 1000)} s).`);
          this.#later(job, delay, 'rate-limit');
          return;
        }
        throw error;
      }
      if (job.cancelled) return;
      job.failures = 0;
      let retryNow = false;
      await this.locks.run(job.key, async () => {
        if (job.cancelled) return;
        const current = this.store.get(job.channelId);
        if (!current || current.status === 'deleted' || current.pendingTransition) {
          this.cancel(job.channelId);
        } else if (channelName(current) !== target) {
          // Un nouveau statut est arrivé pendant la requête : ignorer les étapes
          // intermédiaires et synchroniser uniquement le dernier nom demandé.
          retryNow = true;
        } else {
          const synced = current.renamePending ? this.store.save({ ...current, renamePending: false }) : current;
          this.cancel(job.channelId);
          try { await this.onSynced(channel, synced); }
          catch (error) { this.logger.error('Nom synchronisé, mais panneau non actualisé :', error); }
        }
      });
      if (retryNow) this.#later(job, 0);
    } catch (error) {
      if (job.cancelled) return;
      this.logger.error(`Impossible de synchroniser le nom du salon ${job.channelId} :`, error);
      job.failures++;
      this.#later(job, Math.min(300_000, 30_000 * (2 ** Math.min(job.failures - 1, 4))));
    }
  }
}

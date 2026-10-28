// Un rappel n'est jamais considéré comme une activité humaine.
export const INACTIVITY_DELAY_MS = 24 * 60 * 60 * 1000;
export const INACTIVITY_RETRY_MS = 5 * 60 * 1000;
export const INACTIVITY_SCAN_MS = 60 * 1000;
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 10;

export function inactivityDueAt(ticket) {
  if (!ticket || ['closed', 'deleted'].includes(ticket.status)
    || ticket.pendingDeletion || ticket.pendingTransition || ticket.pendingReclassification) return Infinity;
  const reminder = ticket.inactivityReminder;
  if (reminder?.state === 'sending') return Date.parse(reminder.attemptedAt) + INACTIVITY_RETRY_MS;
  if (reminder?.state === 'sent') return Date.parse(reminder.sentAt) + INACTIVITY_DELAY_MS;
  return Date.parse(ticket.lastActivityAt ?? ticket.createdAt) + INACTIVITY_DELAY_MS;
}

// Vérifie l'historique via REST avant chaque rappel ou suppression. Si la
// vérification est incomplète, on échoue plutôt que de supprimer à l'aveugle.
export async function latestHumanMessageSince(channel, sinceMs) {
  let before;
  for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex++) {
    const page = await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, cache: false, ...(before ? { before } : {}) });
    if (!page || typeof page.values !== 'function' || typeof page.size !== 'number') {
      throw new Error('Historique Discord incomplet ou invalide.');
    }
    if (page.size === 0) return null;
    let latest = null;
    let oldestId = null;
    let oldestTime = Infinity;
    for (const message of page.values()) {
      const timestamp = message?.createdTimestamp;
      if (!/^\d{17,20}$/.test(message?.id ?? '') || !Number.isFinite(timestamp)
        || !message.author || typeof message.author.bot !== 'boolean') {
        throw new Error('Un message Discord ne permet pas de vérifier l’inactivité.');
      }
      if (oldestId === null || BigInt(message.id) < BigInt(oldestId)) oldestId = message.id;
      oldestTime = Math.min(oldestTime, timestamp);
      if (timestamp > sinceMs && !message.author.bot && !message.webhookId
        && (!latest || timestamp > latest.createdTimestamp)) latest = message;
    }
    if (latest) return latest;
    if (page.size < HISTORY_PAGE_SIZE || oldestTime <= sinceMs) return null;
    if (oldestId === before) throw new Error('Pagination Discord invalide pendant la vérification d’inactivité.');
    before = oldestId;
  }
  throw new Error('Historique trop volumineux pour confirmer l’inactivité en sécurité.');
}

// Une boucle unique évite de lancer un traitement concurrent au même intervalle.
export class InactivityMonitor {
  constructor({ guild, service, logger = console, clock = Date.now, intervalMs = INACTIVITY_SCAN_MS }) {
    this.guild = guild;
    this.service = service;
    this.logger = logger;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.retryAfter = new Map();
    this.timer = null;
    this.stopped = true;
    this.running = false;
    this.generation = 0;
  }

  async run() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const tickets = this.service.store.list();
      const active = new Set(tickets.filter((ticket) => !['closed', 'deleted'].includes(ticket.status)).map((ticket) => ticket.channelId));
      for (const id of this.retryAfter.keys()) if (!active.has(id)) this.retryAfter.delete(id);
      for (const ticket of tickets) {
        if (this.stopped || this.service.stopped) break;
        const currentTime = this.clock();
        if (inactivityDueAt(ticket) > currentTime || (this.retryAfter.get(ticket.channelId) ?? 0) > currentTime) continue;
        try {
          await this.service.checkInactivity(this.guild, ticket.channelId);
          this.retryAfter.delete(ticket.channelId);
        } catch (error) {
          this.retryAfter.set(ticket.channelId, this.clock() + INACTIVITY_RETRY_MS);
          this.logger.error(`Impossible de vérifier l’inactivité du ticket #${ticket.number} :`, error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    const tick = async () => {
      try { await this.run(); }
      catch (error) { this.logger.error('Vérification des tickets inactifs impossible :', error); }
      if (!this.stopped && generation === this.generation) {
        this.timer = setTimeout(tick, this.intervalMs);
        this.timer.unref?.();
      }
    };
    void tick();
  }

  stop() {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

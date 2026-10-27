import { ChannelType, OverwriteType, escapeMarkdown } from 'discord.js';
import { channelName, slugify, statusLabel, ticketNumber, TYPE_BY_KEY } from './catalog.js';
import { isFullCategory, isServerChannelLimit, isUnknownChannel, isUnknownMessage, UserError } from './errors.js';
import { KeyedLock } from './lock.js';
import { ChannelNameSynchronizer } from './name-sync.js';
import { closedOwnerWrites, snapshotOwnerWrites, STAFF_ACCESS, ticketOverwrites, OWNER_WRITE_PERMISSIONS } from './permissions.js';
import { initialTicketMessage, ticketPanel, TICKET_PANEL_VERSION } from './ui.js';

const slot = (ownerId, type) => `${ownerId}:${type}`;
const now = () => new Date().toISOString();

export class TicketService {
  constructor({ config, store, botUserId, logger = console }) {
    this.config = config;
    this.store = store;
    this.botUserId = botUserId;
    this.logger = logger;
    this.stopped = false;
    this.locks = new KeyedLock();
    this.names = new ChannelNameSynchronizer({
      store, locks: this.locks, guildId: config.guildId, logger,
      onSynced: (channel, ticket) => this.#refreshPanel(channel, ticket),
    });
  }

  requireTicket(channelId) {
    const ticket = this.store.get(channelId);
    if (!ticket || ticket.status === 'deleted') throw new UserError('Ce salon n’est pas un ticket connu du bot.');
    return ticket;
  }

  #assertGuild(guild) {
    if (!guild || guild.id !== this.config.guildId) throw new UserError('Ce serveur n’est pas autorisé.');
  }

  async #fetchChannel(guild, ticket) {
    let channel;
    try {
      channel = await guild.channels.fetch(ticket.channelId, { force: true });
    } catch (error) {
      if (!isUnknownChannel(error)) throw error;
      channel = null;
    }
    if (!channel) {
      this.store.markDeleted(ticket.channelId);
      this.names.cancel(ticket.channelId);
      return null;
    }
    if (channel.guildId !== this.config.guildId || channel.type !== ChannelType.GuildText) {
      throw new Error(`Le salon ${ticket.channelId} n’est pas un salon texte de ce serveur.`);
    }
    return channel;
  }

  async #findExisting(guild, ownerId, type) {
    const ticket = this.store.findOpen(ownerId, type);
    if (!ticket) return null;
    return await this.#fetchChannel(guild, ticket) ? ticket : null;
  }

  async #withTicket(guild, channelId, action) {
    this.#assertGuild(guild);
    const original = this.requireTicket(channelId);
    return this.locks.run(slot(original.ownerId, original.type), async () => {
      let ticket = this.requireTicket(channelId);
      const channel = await this.#fetchChannel(guild, ticket);
      if (!channel) throw new UserError('Ce salon de ticket n’existe plus.');
      if (ticket.pendingTransition) ticket = await this.#restoreTransition(guild, channel, ticket);
      return action(ticket, channel);
    });
  }

  async open(guild, user, typeKey) {
    this.#assertGuild(guild);
    if (!Object.hasOwn(TYPE_BY_KEY, typeKey)) throw new UserError('Cette catégorie de ticket n’existe pas.');
    if (user.id === this.botUserId) throw new UserError('Le bot ne peut pas ouvrir de ticket pour lui-même.');
    const type = TYPE_BY_KEY[typeKey];
    const categoryId = this.config.categoryIdsByType[typeKey];
    if (!categoryId) throw new Error(`ID de catégorie manquant pour ${type.label} dans config.json.`);
    return this.locks.run(slot(user.id, typeKey), async () => {
      const existing = await this.#findExisting(guild, user.id, typeKey);
      if (existing) return { created: false, ticket: existing };

      const createdAt = now();
      const ticket = {
        channelId: '', number: this.store.allocateNumber(), type: typeKey,
        ownerId: user.id, ownerName: user.globalName || user.username || 'membre',
        status: 'waiting', assignedTo: null, progressDetail: null,
        staffRoleIds: [...this.config.staffRolesByType[typeKey]], roleSyncPending: null,
        pendingTransition: null, renamePending: false, panelMessageId: null, panelVersion: null,
        createdAt, updatedAt: createdAt, closedAt: null, closedPermissions: null, deletedAt: null,
      };
      let channel;
      try {
        channel = await guild.channels.create({
          name: channelName(ticket),
          type: ChannelType.GuildText,
          parent: categoryId,
          topic: `Ticket #${ticketNumber(ticket.number)} | ${type.label} | Créateur : ${user.id}`,
          permissionOverwrites: ticketOverwrites(guild.id, this.botUserId, user.id, ticket.staffRoleIds),
          reason: `Ouverture du ticket #${ticketNumber(ticket.number)} par ${user.id}`,
        });
      } catch (error) {
        // Ne jamais contourner une catégorie pleine en créant le salon à la racine.
        if (isFullCategory(error)) {
          throw new UserError(`Impossible d’ouvrir le ticket : la catégorie ${type.label} est pleine. Prévenez l’équipe pour qu’elle libère de la place.`);
        }
        if (isServerChannelLimit(error)) {
          throw new UserError('Impossible d’ouvrir le ticket : la limite de salons du serveur est atteinte. Prévenez l’équipe.');
        }
        throw error;
      }
      ticket.channelId = channel.id;
      try {
        // Le registre existe avant l'envoi des boutons, afin qu'ils soient immédiatement utilisables.
        this.store.save(ticket);
      } catch (error) {
        try { await channel.delete('Échec de l’enregistrement du ticket'); }
        catch (rollbackError) { this.logger.error('Impossible de supprimer le salon après échec du stockage :', rollbackError); }
        throw error;
      }

      let warning = '';
      try {
        const message = await channel.send(initialTicketMessage(ticket));
        try {
          ticket.panelMessageId = message.id;
          ticket.panelVersion = TICKET_PANEL_VERSION;
          this.store.save(ticket);
        } catch (error) {
          this.logger.error('Ticket créé, mais ID du panneau non enregistré :', error);
          warning = 'Le ticket est ouvert, mais son panneau devra peut-être être réparé avec /ticket-panneau.';
        }
      } catch (error) {
        this.logger.error('Ticket créé, mais panneau impossible à envoyer :', error);
        warning = 'Le ticket est ouvert, mais le panneau n’a pas pu être envoyé. Prévenez le staff : /ticket-panneau permet de le rétablir.';
      }
      return { created: true, ticket: this.store.get(channel.id), warning };
    });
  }

  async #refreshPanel(channel, ticket) {
    let message = null;
    if (ticket.panelMessageId) {
      try {
        message = await channel.messages.fetch(ticket.panelMessageId);
      } catch (error) {
        if (!isUnknownMessage(error)) throw error;
      }
    }
    if (message) {
      await message.edit(ticketPanel(ticket));
      if (ticket.panelVersion !== TICKET_PANEL_VERSION) {
        this.store.save({ ...ticket, panelVersion: TICKET_PANEL_VERSION });
      }
      return message;
    }
    message = await channel.send(ticketPanel(ticket));
    this.store.save({ ...ticket, panelMessageId: message.id, panelVersion: TICKET_PANEL_VERSION });
    return message;
  }

  async #announceTransition(channel, ticket, actorId) {
    await channel.send({
      content: `${escapeMarkdown(statusLabel(ticket))} • Mise à jour par <@${actorId}>.`,
      allowedMentions: { parse: [] },
    });
  }

  async #restoreTransition(guild, channel, ticket) {
    const previousWrites = ticket.pendingTransition.ownerWrites;
    if (previousWrites) {
      await channel.permissionOverwrites.edit(ticket.ownerId, previousWrites, {
        type: OverwriteType.Member, reason: 'Restauration après une transition interrompue',
      });
    }
    const restored = { ...ticket, pendingTransition: null, renamePending: true };
    this.store.save(restored);
    this.names.schedule(guild, ticket.channelId);
    try { await this.#refreshPanel(channel, restored); }
    catch (error) { this.logger.error('Transition restaurée, mais panneau non actualisé :', error); }
    return this.store.get(ticket.channelId);
  }

  async #commitTransition(guild, channel, oldTicket, nextTicket, actorId, ownerChange = null) {
    // Journaliser l’état précédent avant les appels Discord permet de le restaurer
    // au redémarrage si le processus s’arrête entre deux opérations.
    const pending = { ...oldTicket, pendingTransition: { ownerWrites: ownerChange?.before ?? null } };
    this.store.save(pending);
    const committed = { ...nextTicket, pendingTransition: null, renamePending: true };
    try {
      if (ownerChange) {
        await channel.permissionOverwrites.edit(oldTicket.ownerId, ownerChange.after, {
          type: OverwriteType.Member, reason: `Gestion du ticket #${ticketNumber(oldTicket.number)}`,
        });
      }
      this.store.save(committed);
    } catch (error) {
      try {
        const current = await this.#fetchChannel(guild, pending);
        if (current) await this.#restoreTransition(guild, current, pending);
      } catch (rollbackError) {
        // Le journal reste en place et la restauration sera retentée au démarrage.
        this.logger.error('Impossible de restaurer la transition du ticket :', rollbackError);
      }
      throw error;
    }

    // Discord limite les renommages : ne pas bloquer les autres actions du ticket.
    this.names.schedule(guild, committed.channelId);
    const warnings = [];
    try { await this.#refreshPanel(channel, committed); }
    catch (error) {
      this.logger.error('Statut enregistré, mais panneau non mis à jour :', error);
      warnings.push('Le panneau n’a pas pu être actualisé : utilisez /ticket-panneau.');
    }
    try { await this.#announceTransition(channel, committed, actorId); }
    catch (error) {
      this.logger.error('Statut enregistré, mais message de suivi non envoyé :', error);
      warnings.push('Le message de suivi n’a pas pu être envoyé.');
    }
    return { ticket: this.store.get(oldTicket.channelId), warning: warnings.join(' ') };
  }

  async setStatus(guild, channelId, status, actorId, detail = '') {
    if (!['waiting', 'claimed', 'progress', 'resolved'].includes(status)) throw new Error('Transition de statut invalide.');
    const cleanedDetail = String(detail).replace(/\s+/g, ' ').trim();
    if (status === 'progress' && (cleanedDetail.length < 2 || cleanedDetail.length > 40 || !slugify(cleanedDetail))) {
      throw new UserError('Indiquez une étape de 2 à 40 caractères contenant au moins une lettre ou un chiffre.');
    }
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status === 'closed') throw new UserError('Ce ticket est fermé. Rouvrez-le avant de modifier son statut.');
      const progressDetail = status === 'progress' ? cleanedDetail : null;
      const assignedTo = status === 'waiting' ? null : (status === 'claimed' ? actorId : (ticket.assignedTo || actorId));
      if (ticket.status === status && ticket.progressDetail === progressDetail && ticket.assignedTo === assignedTo) {
        if (ticket.renamePending) this.names.schedule(guild, channelId, { retryNow: true });
        return { ticket, warning: '', unchanged: true };
      }
      const next = { ...ticket, status, progressDetail, assignedTo, updatedAt: now() };
      return this.#commitTransition(guild, channel, ticket, next, actorId);
    });
  }

  async close(guild, channelId, actorId) {
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status === 'closed') throw new UserError('Ce ticket est déjà fermé.');
      const timestamp = now();
      const before = snapshotOwnerWrites(channel, ticket.ownerId);
      const next = {
        ...ticket, status: 'closed', progressDetail: null, closedAt: timestamp,
        closedPermissions: before, updatedAt: timestamp,
      };
      return this.#commitTransition(guild, channel, ticket, next, actorId, { before, after: closedOwnerWrites() });
    });
  }

  async reopen(guild, channelId, actorId) {
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status !== 'closed') throw new UserError('Ce ticket n’est pas fermé.');
      const existing = await this.#findExisting(guild, ticket.ownerId, ticket.type);
      if (existing) throw new UserError('Un autre ticket de ce type est déjà ouvert pour ce membre. Fermez-le avant de rouvrir celui-ci.');
      const saved = ticket.closedPermissions;
      if (!saved || OWNER_WRITE_PERMISSIONS.some((name) => ![true, false, null].includes(saved[name]))) {
        throw new UserError('Les permissions précédentes sont introuvables. Un administrateur doit vérifier ce salon.');
      }
      const next = {
        ...ticket, status: 'waiting', assignedTo: null, progressDetail: null,
        closedAt: null, closedPermissions: null, updatedAt: now(),
      };
      const before = snapshotOwnerWrites(channel, ticket.ownerId);
      return this.#commitTransition(guild, channel, ticket, next, actorId, { before, after: saved });
    });
  }

  async delete(guild, channelId) {
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status !== 'closed') throw new UserError('Fermez le ticket avant de le supprimer.');
      await channel.delete(`Suppression du ticket fermé #${ticketNumber(ticket.number)}`);
      this.names.cancel(channelId);
      this.store.markDeleted(channelId);
    });
  }

  async repair(guild, channelId) {
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      const next = { ...ticket, renamePending: true };
      this.store.save(next);
      this.names.schedule(guild, channelId, { retryNow: true });
      return this.#refreshPanel(channel, next);
    });
  }

  async channelDeleted(channel) {
    if (channel.guildId !== this.config.guildId) return;
    this.names.cancel(channel.id);
    const ticket = this.store.get(channel.id);
    if (!ticket || ticket.status === 'deleted') return;
    await this.locks.run(slot(ticket.ownerId, ticket.type), () => this.store.markDeleted(channel.id));
  }

  async recoverPendingTransitions(guild) {
    this.#assertGuild(guild);
    for (const stored of this.store.list()) {
      if (stored.status === 'deleted' || !stored.pendingTransition) continue;
      await this.locks.run(slot(stored.ownerId, stored.type), async () => {
        const ticket = this.store.get(stored.channelId);
        if (!ticket || ticket.status === 'deleted' || !ticket.pendingTransition) return;
        const channel = await this.#fetchChannel(guild, ticket);
        if (channel) await this.#restoreTransition(guild, channel, ticket);
      });
    }
  }

  resumePendingRenames(guild) {
    this.#assertGuild(guild);
    for (const ticket of this.store.list()) {
      if (ticket.status !== 'deleted' && ticket.renamePending && !ticket.pendingTransition) {
        this.names.schedule(guild, ticket.channelId);
      }
    }
  }

  // Les anciens panneaux gagnent les nouveaux boutons sans intervention manuelle.
  // La tâche est lancée en arrière-plan, séquentiellement et sous les mêmes verrous
  // que les actions, afin de ne pas écraser un statut modifié entre-temps.
  async refreshOutdatedPanels(guild) {
    this.#assertGuild(guild);
    for (const stored of this.store.list()) {
      if (this.stopped) return;
      if (stored.status === 'deleted' || (stored.panelVersion ?? 0) >= TICKET_PANEL_VERSION) continue;
      try {
        await this.locks.run(slot(stored.ownerId, stored.type), async () => {
          let ticket = this.store.get(stored.channelId);
          if (this.stopped || !ticket || ticket.status === 'deleted' || (ticket.panelVersion ?? 0) >= TICKET_PANEL_VERSION) return;
          const channel = await this.#fetchChannel(guild, ticket);
          if (!channel || this.stopped) return;
          if (ticket.pendingTransition) ticket = await this.#restoreTransition(guild, channel, ticket);
          if ((ticket.panelVersion ?? 0) < TICKET_PANEL_VERSION) await this.#refreshPanel(channel, ticket);
        });
      } catch (error) {
        // Un salon inaccessible ne doit pas empêcher la mise à jour des autres.
        this.logger.error(`Impossible de mettre à jour le panneau du ticket #${ticketNumber(stored.number)} :`, error);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.names.stop();
  }

  // Enregistrer tous les rôles potentiellement touchés AVANT de modifier Discord.
  // Après une interruption, même si la configuration change encore, on peut
  // retirer les accès partiels et réappliquer exactement les rôles désirés.
  async syncConfiguredRoles(guild) {
    this.#assertGuild(guild);
    for (const stored of this.store.list()) {
      if (stored.status === 'deleted') continue;
      const desired = this.config.staffRolesByType[stored.type];
      const oldSet = new Set(stored.staffRoleIds);
      const newSet = new Set(desired);
      const differs = oldSet.size !== newSet.size || [...oldSet].some((id) => !newSet.has(id));
      if (!differs && !stored.roleSyncPending) continue;
      await this.locks.run(slot(stored.ownerId, stored.type), async () => {
        const ticket = this.store.get(stored.channelId);
        if (!ticket || ticket.status === 'deleted') return;
        const channel = await this.#fetchChannel(guild, ticket);
        if (!channel) return;
        const candidates = [...new Set([...ticket.staffRoleIds, ...(ticket.roleSyncPending ?? []), ...desired])];
        this.store.save({ ...ticket, roleSyncPending: candidates });
        for (const roleId of candidates) {
          if (!newSet.has(roleId) && channel.permissionOverwrites.cache.has(roleId)) {
            await channel.permissionOverwrites.delete(roleId, 'Mise à jour des rôles de tickets');
          }
        }
        for (const roleId of desired) {
          await channel.permissionOverwrites.edit(roleId, STAFF_ACCESS, {
            type: OverwriteType.Role, reason: 'Mise à jour des rôles de tickets',
          });
        }
        const next = { ...ticket, staffRoleIds: [...desired], roleSyncPending: null };
        this.store.save(next);
        try { await this.#refreshPanel(channel, next); }
        catch (error) { this.logger.error('Rôles mis à jour, mais panneau non actualisé :', error); }
      });
    }
  }
}

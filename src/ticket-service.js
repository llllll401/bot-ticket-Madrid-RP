import { ChannelType, OverwriteType, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { channelName, slugify, statusLabel, ticketNumber, TYPE_BY_KEY } from './catalog.js';
import { cleanDossierText, MAX_INTERNAL_NOTES, MAX_INTERNAL_NOTE_LENGTH, MAX_ROLE_MESSAGE_LENGTH } from './dossier.js';
import { isFullCategory, isServerChannelLimit, isUnknownChannel, isUnknownMessage, UserError } from './errors.js';
import { KeyedLock } from './lock.js';
import { ChannelNameSynchronizer } from './name-sync.js';
import { snapshotOwnerWrites, STAFF_ACCESS, ticketOverwrites, OWNER_WRITE_PERMISSIONS } from './permissions.js';
import { initialTicketMessage, ticketPanel, TICKET_PANEL_VERSION } from './ui.js';

// Un verrou par propriétaire protège aussi les déplacements entre deux types.
const slot = (ownerId) => ownerId;
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

  #clearPendingDeletion(guild, ticket) {
    const restored = this.store.save({ ...ticket, pendingDeletion: null });
    if (restored.renamePending) this.names.schedule(guild, restored.channelId);
    return restored;
  }

  async #withTicket(guild, channelId, action, {
    restoreTransition = true, allowPendingReclassification = false, expectedCategory = null, authorize = null,
  } = {}) {
    this.#assertGuild(guild);
    const original = this.requireTicket(channelId);
    return this.locks.run(slot(original.ownerId), async () => {
      let ticket = this.requireTicket(channelId);
      const channel = await this.#fetchChannel(guild, ticket);
      if (!channel) throw new UserError('Ce salon de ticket n’existe plus.');
      if (ticket.pendingDeletion) ticket = this.#clearPendingDeletion(guild, ticket);
      if (ticket.pendingReclassification && !allowPendingReclassification) {
        throw new UserError('Un changement de catégorie est interrompu. Un administrateur doit vérifier les droits et redémarrer le bot.');
      }
      if (expectedCategory && (ticket.type !== expectedCategory.type
        || (ticket.categoryRevision ?? 0) !== expectedCategory.revision)) {
        throw new UserError('La catégorie du ticket a changé. Relancez cette action.');
      }
      if (authorize) await authorize(ticket, channel);
      if (ticket.pendingTransition && restoreTransition) ticket = await this.#restoreTransition(guild, channel, ticket);
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
    return this.locks.run(slot(user.id), async () => {
      const existing = await this.#findExisting(guild, user.id, typeKey);
      if (existing?.pendingReclassification) {
        throw new UserError('Un changement de catégorie pour l’un de vos tickets est en cours. Prévenez l’équipe avant de réessayer.');
      }
      if (existing) return { created: false, ticket: existing };

      const createdAt = now();
      const ticket = {
        channelId: '', number: this.store.allocateNumber(), type: typeKey,
        ownerId: user.id, ownerName: user.globalName || user.username || 'membre',
        status: 'waiting', assignedTo: null, assignmentRevision: 0, categoryRevision: 0, progressDetail: null, urgent: false,
        staffRoleIds: [...this.config.staffRolesByType[typeKey]], roleSyncPending: null, internalNotes: [],
        pendingTransition: null, pendingDeletion: null, pendingReclassification: null,
        renamePending: false, panelMessageId: null, panelVersion: null,
        createdAt, updatedAt: createdAt, closedAt: null, closedBy: null, closedPermissions: null,
        deletedAt: null, deletedBy: null, deletionRequestedAt: null,
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

  async setStatus(guild, channelId, status, actorId, detail = '', { expectedAssignee, expectedAssignmentRevision, expectedCategory, authorize } = {}) {
    if (!['waiting', 'claimed', 'progress', 'resolved'].includes(status)) throw new Error('Transition de statut invalide.');
    const cleanedDetail = String(detail).replace(/\s+/g, ' ').trim();
    if (status === 'progress' && (cleanedDetail.length < 2 || cleanedDetail.length > 40 || !slugify(cleanedDetail))) {
      throw new UserError('Indiquez une étape de 2 à 40 caractères contenant au moins une lettre ou un chiffre.');
    }
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status === 'closed') throw new UserError('Ce ticket est fermé. Rouvrez-le avant de modifier son statut.');
      if (status === 'claimed') {
        if (expectedAssignee !== undefined && (ticket.assignedTo !== expectedAssignee
          || (ticket.assignmentRevision ?? 0) !== expectedAssignmentRevision)) {
          throw new UserError('Le responsable a changé depuis votre demande. Relancez la prise en charge.');
        }
        if (ticket.assignedTo && ticket.assignedTo !== actorId && expectedAssignee === undefined) {
          return { ticket, conflict: ticket.assignedTo };
        }
      }
      const progressDetail = status === 'progress' ? cleanedDetail : null;
      const assignedTo = status === 'waiting' ? null : (status === 'claimed' ? actorId : (ticket.assignedTo || actorId));
      if (ticket.status === status && ticket.progressDetail === progressDetail && ticket.assignedTo === assignedTo) {
        if (ticket.renamePending) this.names.schedule(guild, channelId, { retryNow: true });
        return { ticket, warning: '', unchanged: true };
      }
      const assignmentRevision = (ticket.assignmentRevision ?? 0) + Number(ticket.assignedTo !== assignedTo);
      const next = { ...ticket, status, progressDetail, assignedTo, assignmentRevision, updatedAt: now() };
      return this.#commitTransition(guild, channel, ticket, next, actorId);
    }, { expectedCategory, authorize });
  }

  async toggleAssignment(guild, channelId, actorId, { expectedCategory, expectedAssignmentRevision, authorize } = {}) {
    if (!Number.isSafeInteger(expectedAssignmentRevision) || expectedAssignmentRevision < 0) {
      throw new UserError('Ce bouton a expiré. Utilisez le panneau actualisé.');
    }
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status === 'closed') throw new UserError('Ce ticket est fermé.');
      const revision = ticket.assignmentRevision ?? 0;
      // Deux clics sur le même panneau ne doivent pas prendre puis aussitôt
      // laisser le ticket, ni modifier une attribution qui a changé entre-temps.
      if (revision !== expectedAssignmentRevision) {
        throw new UserError('Le responsable a changé depuis l’affichage. Utilisez le bouton actualisé ou /ticket-panneau.');
      }
      if (ticket.assignedTo && ticket.assignedTo !== actorId) return { ticket, conflict: ticket.assignedTo };
      if (revision === Number.MAX_SAFE_INTEGER) {
        throw new UserError('Le compteur d’attribution est épuisé. Prévenez un administrateur.');
      }
      const released = ticket.assignedTo === actorId;
      const next = {
        ...ticket, status: released ? 'waiting' : 'claimed', assignedTo: released ? null : actorId,
        progressDetail: null, assignmentRevision: revision + 1, updatedAt: now(),
      };
      const result = await this.#commitTransition(guild, channel, ticket, next, actorId);
      return { ...result, released };
    }, { expectedCategory, authorize });
  }

  async setUrgent(guild, channelId, urgent, actorId, { expectedCategory, authorize } = {}) {
    if (typeof urgent !== 'boolean') throw new Error('Priorité invalide.');
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status === 'closed') throw new UserError('Ce ticket est fermé.');
      if (Boolean(ticket.urgent) === urgent) return { ticket, warning: '', unchanged: true };
      // Ne pas changer updatedAt : l'ancienneté de la file dépend du statut,
      // pas d'un ajustement de priorité.
      const next = this.store.save({ ...ticket, urgent });
      const warnings = [];
      try { await this.#refreshPanel(channel, next); }
      catch (error) {
        this.logger.error('Priorité enregistrée, mais panneau non actualisé :', error);
        warnings.push('Le panneau n’a pas pu être actualisé : utilisez /ticket-panneau.');
      }
      try {
        await channel.send({
          content: `${urgent ? '🚨 Priorité urgente' : 'Priorité normale'} • Mise à jour par <@${actorId}>.`,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        this.logger.error('Priorité enregistrée, mais message de suivi non envoyé :', error);
        warnings.push('Le message de suivi n’a pas pu être envoyé.');
      }
      return { ticket: this.store.get(channelId), warning: warnings.join(' ') };
    }, { expectedCategory, authorize });
  }

  async #applyReclassification(guild, channel, ticket) {
    const journal = ticket.pendingReclassification;
    const targetType = journal.targetType;
    const desired = this.config.staffRolesByType[targetType];
    const categoryId = this.config.categoryIdsByType[targetType];
    const candidates = [...new Set([...journal.candidateRoleIds, ...ticket.staffRoleIds, ...(ticket.roleSyncPending ?? []), ...desired])];
    if (candidates.length !== journal.candidateRoleIds.length) {
      // Inclure les rôles d'une configuration modifiée avant de toucher Discord.
      ticket = this.store.save({ ...ticket, pendingReclassification: { ...journal, candidateRoleIds: candidates } });
    }
    const reason = `Changement de catégorie du ticket #${ticketNumber(ticket.number)} par ${journal.actorId}`;
    // Retirer les anciens rôles AVANT d'accorder les nouveaux ; ne pas toucher
    // aux accès manuels d'autres rôles ou membres, ni synchroniser la catégorie.
    for (const roleId of candidates) {
      if (!desired.includes(roleId) && channel.permissionOverwrites.cache.has(roleId)) {
        await channel.permissionOverwrites.delete(roleId, reason);
      }
    }
    for (const roleId of desired) {
      await channel.permissionOverwrites.edit(roleId, STAFF_ACCESS, { type: OverwriteType.Role, reason });
    }
    await channel.edit({
      parent: categoryId, lockPermissions: false,
      topic: `Ticket #${ticketNumber(ticket.number)} | ${TYPE_BY_KEY[targetType].label} | Créateur : ${ticket.ownerId}`,
      reason,
    });
    const next = this.store.save({
      ...ticket, type: targetType, categoryRevision: (ticket.categoryRevision ?? 0) + 1,
      status: 'waiting', assignedTo: null, progressDetail: null,
      assignmentRevision: (ticket.assignmentRevision ?? 0) + Number(ticket.assignedTo !== null),
      staffRoleIds: [...desired], roleSyncPending: null, pendingReclassification: null,
      renamePending: true, updatedAt: now(),
    });
    this.names.schedule(guild, channel.id);
    const warnings = [];
    try { await this.#refreshPanel(channel, next); }
    catch (error) {
      this.logger.error('Catégorie changée, mais panneau non actualisé :', error);
      warnings.push('Le panneau n’a pas pu être actualisé : utilisez /ticket-panneau.');
    }
    try {
      await channel.send({
        content: `🔄 Catégorie : **${TYPE_BY_KEY[targetType].label}**. Le ticket est remis en attente.`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      this.logger.error('Catégorie changée, mais message de suivi non envoyé :', error);
      warnings.push('Le message de suivi n’a pas pu être envoyé.');
    }
    return { ticket: this.store.get(channel.id), warning: warnings.join(' ') };
  }

  async changeCategory(guild, channelId, targetType, actorId, { expectedCategory, authorize } = {}) {
    if (!Object.hasOwn(TYPE_BY_KEY, targetType)) throw new UserError('Choisissez une catégorie valide.');
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status === 'closed') throw new UserError('Rouvrez cet ancien ticket avant de changer sa catégorie.');
      if (ticket.type === targetType) return { ticket, warning: '', unchanged: true };
      const existing = await this.#findExisting(guild, ticket.ownerId, targetType);
      if (existing) throw new UserError('Ce membre possède déjà un ticket ouvert dans la catégorie choisie.');
      const pending = this.store.save({
        ...ticket, pendingReclassification: {
          targetType, actorId, requestedAt: now(),
          candidateRoleIds: [...new Set([...ticket.staffRoleIds, ...(ticket.roleSyncPending ?? []), ...this.config.staffRolesByType[targetType]])],
        },
      });
      try {
        return await this.#applyReclassification(guild, channel, pending);
      } catch (error) {
        this.logger.error('Changement de catégorie interrompu :', error);
        // Si le salon a disparu, finaliser sa suppression ; sinon conserver le
        // journal et les deux emplacements réservés jusqu'à la reprise.
        let channelExists = null;
        try { channelExists = Boolean(await this.#fetchChannel(guild, pending)); }
        catch (checkError) { this.logger.error('Impossible de vérifier le salon après interruption :', checkError); }
        if (channelExists === false) throw new UserError('Le salon de ce ticket n’existe plus.');
        if (isFullCategory(error)) {
          throw new UserError('La catégorie Discord est pleine et certains accès ont pu changer. Prévenez un administrateur, libérez de la place puis redémarrez le bot.');
        }
        throw new UserError('Le changement de catégorie est interrompu et certains accès ont pu changer. Prévenez un administrateur, vérifiez les droits puis redémarrez le bot.');
      }
    }, { expectedCategory, authorize });
  }

  async addInternalNote(guild, channelId, actorId, value, { expectedCategory, authorize } = {}) {
    const text = cleanDossierText(value, MAX_INTERNAL_NOTE_LENGTH, 'La note interne');
    return this.#withTicket(guild, channelId, async (ticket) => {
      if (ticket.status === 'closed') throw new UserError('Ce ticket est fermé.');
      const notes = ticket.internalNotes ?? [];
      if (notes.length >= MAX_INTERNAL_NOTES) throw new UserError(`Ce dossier contient déjà ${MAX_INTERNAL_NOTES} notes internes.`);
      const saved = this.store.save({
        ...ticket, internalNotes: [...notes, { authorId: actorId, createdAt: now(), text }],
      });
      // Une note interne ne doit jamais être publiée dans le salon du membre.
      return { count: saved.internalNotes.length };
    }, { expectedCategory, authorize });
  }

  async getInternalNotes(guild, channelId, { expectedCategory, authorize } = {}) {
    return this.#withTicket(guild, channelId, async (ticket) => {
      if (ticket.status === 'closed') throw new UserError('Ce ticket est fermé.');
      return ticket.internalNotes ?? [];
    }, { expectedCategory, authorize });
  }

  async notifyRole(guild, channelId, actorId, roleId, value, { expectedCategory, authorize } = {}) {
    const text = cleanDossierText(value, MAX_ROLE_MESSAGE_LENGTH, 'Le message au rôle');
    if (typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId) || roleId === guild.id) {
      throw new UserError('Choisissez un rôle du serveur autre que @everyone.');
    }
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status === 'closed') throw new UserError('Ce ticket est fermé.');
      let role;
      try { role = await guild.roles.fetch(roleId, { force: true }); }
      catch (error) {
        if (Number(error?.code) !== 10011) throw error;
      }
      if (!role || role.id !== roleId || role.guild?.id !== guild.id) throw new UserError('Ce rôle est introuvable sur ce serveur.');
      if (!role.mentionable) {
        const bot = await guild.members.fetchMe({ force: true });
        if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.MentionEveryone)) {
          throw new UserError('Ce rôle n’est pas mentionnable. Rendez-le mentionnable ou autorisez le bot à mentionner les rôles dans ce salon.');
        }
      }
      await channel.send({
        content: `<@&${roleId}> • Demande de <@${actorId}> :\n${escapeMarkdown(text)}`,
        // Même si le texte contient @everyone, un utilisateur ou un autre rôle,
        // seul le rôle choisi peut être notifié.
        allowedMentions: { parse: [], roles: [roleId] },
      });
      return { roleId };
    }, { expectedCategory, authorize });
  }

  async #deleteConfirmed(guild, ticket, channel, actorId) {
    // Conserver l'intention AVANT l'appel Discord. Après une interruption, on
    // vérifie l'existence du salon au lieu de le supprimer sans confirmation.
    const pending = this.store.save({ ...ticket, pendingDeletion: { actorId, requestedAt: now() } });
    // Ne pas retirer un renommage encore en vol tant que la suppression peut
    // échouer : cela permet de le reprendre sans lancer deux PATCH concurrents.
    try {
      await channel.delete(`Fermeture du ticket #${ticketNumber(ticket.number)} par ${actorId}`);
    } catch (error) {
      if (!isUnknownChannel(error)) {
        let stillExists;
        try {
          stillExists = Boolean(await guild.channels.fetch(ticket.channelId, { force: true }));
        } catch (checkError) {
          if (isUnknownChannel(checkError)) stillExists = false;
          else {
            this.logger.error('Impossible de vérifier une suppression de ticket interrompue :', checkError);
            throw new UserError('Impossible de vérifier la suppression. Prévenez un administrateur avant de réessayer.');
          }
        }
        if (stillExists) {
          this.#clearPendingDeletion(guild, pending);
          this.logger.error('Le salon du ticket n’a pas pu être supprimé :', error);
          throw new UserError('Le salon n’a pas été supprimé. Vérifiez les permissions du bot puis réessayez.');
        }
      }
    }
    // Un éventuel événement ChannelDelete est sérialisé par le même verrou.
    try {
      return { ticket: this.store.markDeleted(ticket.channelId) };
    } finally {
      // Même en cas d'échec disque, Discord a confirmé la disparition du salon.
      this.names.cancel(ticket.channelId);
    }
  }

  // Une suppression confirmée ne nécessite pas de restaurer les permissions
  // d'une transition inachevée ; si elle échoue, son journal reste intact.
  async close(guild, channelId, actorId, { expectedCategory } = {}) {
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status === 'closed') throw new UserError('Cet ancien ticket est déjà fermé. Utilisez Supprimer pour retirer son salon.');
      return this.#deleteConfirmed(guild, ticket, channel, actorId);
    }, { restoreTransition: false, allowPendingReclassification: true, expectedCategory });
  }

  async reopen(guild, channelId, actorId, { expectedCategory } = {}) {
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
        assignmentRevision: (ticket.assignmentRevision ?? 0) + Number(ticket.assignedTo !== null),
        closedAt: null, closedBy: null, closedPermissions: null, updatedAt: now(),
      };
      const before = snapshotOwnerWrites(channel, ticket.ownerId);
      return this.#commitTransition(guild, channel, ticket, next, actorId, { before, after: saved });
    }, { expectedCategory });
  }

  async delete(guild, channelId, actorId, { expectedCategory } = {}) {
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      if (ticket.status !== 'closed') throw new UserError('Utilisez Fermer pour supprimer ce ticket.');
      return this.#deleteConfirmed(guild, ticket, channel, actorId);
    }, { restoreTransition: false, allowPendingReclassification: true, expectedCategory });
  }

  async repair(guild, channelId, { expectedCategory } = {}) {
    return this.#withTicket(guild, channelId, async (ticket, channel) => {
      const next = { ...ticket, renamePending: true };
      this.store.save(next);
      this.names.schedule(guild, channelId, { retryNow: true });
      return this.#refreshPanel(channel, next);
    }, { expectedCategory });
  }

  async channelDeleted(channel) {
    if (channel.guildId !== this.config.guildId) return;
    this.names.cancel(channel.id);
    const ticket = this.store.get(channel.id);
    if (!ticket || ticket.status === 'deleted') return;
    await this.locks.run(slot(ticket.ownerId), () => this.store.markDeleted(channel.id));
  }

  async recoverPendingDeletions(guild) {
    this.#assertGuild(guild);
    for (const stored of this.store.list()) {
      if (stored.status === 'deleted' || !stored.pendingDeletion) continue;
      await this.locks.run(slot(stored.ownerId), async () => {
        const ticket = this.store.get(stored.channelId);
        if (!ticket || ticket.status === 'deleted' || !ticket.pendingDeletion) return;
        const channel = await this.#fetchChannel(guild, ticket);
        // S'il existe encore, l'opération n'est pas reprise sans nouvelle
        // confirmation. S'il n'existe plus, #fetchChannel l'a marqué supprimé.
        if (channel) this.#clearPendingDeletion(guild, ticket);
      });
    }
  }

  async recoverPendingReclassifications(guild) {
    this.#assertGuild(guild);
    for (const stored of this.store.list()) {
      if (stored.status === 'deleted' || !stored.pendingReclassification) continue;
      await this.locks.run(slot(stored.ownerId), async () => {
        const ticket = this.store.get(stored.channelId);
        if (!ticket || ticket.status === 'deleted' || !ticket.pendingReclassification) return;
        const channel = await this.#fetchChannel(guild, ticket);
        if (channel) await this.#applyReclassification(guild, channel, ticket);
      });
    }
  }

  async recoverPendingTransitions(guild) {
    this.#assertGuild(guild);
    for (const stored of this.store.list()) {
      if (stored.status === 'deleted' || !stored.pendingTransition) continue;
      await this.locks.run(slot(stored.ownerId), async () => {
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

  // Une suppression manuelle pendant l'arrêt du bot ne déclenche aucun événement.
  // Une seule liste suffit pour les salons présents ; vérifier chaque absence par
  // son ID avant d'effacer les notes, car une perte d'accès n'est pas une suppression.
  async reconcileMissingChannels(guild) {
    this.#assertGuild(guild);
    const tickets = this.store.list().filter((ticket) => ticket.status !== 'deleted');
    if (!tickets.length || this.stopped) return;
    let channels;
    // Ne pas appliquer au cache une liste qui pourrait être antérieure à une
    // modification de permissions effectuée en parallèle sur un ticket actif.
    try { channels = await guild.channels.fetch(undefined, { cache: false }); }
    catch (error) {
      this.logger.error('Impossible de vérifier les salons des tickets au démarrage :', error);
      return;
    }
    for (const stored of tickets) {
      if (this.stopped) return;
      if (channels.has(stored.channelId)) continue;
      try {
        await this.locks.run(slot(stored.ownerId), async () => {
          const ticket = this.store.get(stored.channelId);
          if (!ticket || ticket.status === 'deleted' || this.stopped) return;
          await this.#fetchChannel(guild, ticket);
        });
      } catch (error) {
        this.logger.error(`Impossible de vérifier le salon du ticket #${ticketNumber(stored.number)} :`, error);
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
        await this.locks.run(slot(stored.ownerId), async () => {
          let ticket = this.store.get(stored.channelId);
          if (this.stopped || !ticket || ticket.status === 'deleted' || ticket.pendingReclassification
            || (ticket.panelVersion ?? 0) >= TICKET_PANEL_VERSION) return;
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
      await this.locks.run(slot(stored.ownerId), async () => {
        const ticket = this.store.get(stored.channelId);
        if (!ticket || ticket.status === 'deleted') return;
        if (ticket.pendingReclassification) throw new Error('Un changement de catégorie doit être repris avant la synchronisation des rôles.');
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

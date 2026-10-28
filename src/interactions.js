import { ChannelType, MessageFlags, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { statusLabel, TYPE_BY_KEY } from './catalog.js';
import { UserError } from './errors.js';
import { KeyedLock } from './lock.js';
import { isOverviewButton, overviewQueryFromOptions, parseOverviewButton, renderOverview } from './overview.js';
import { canManageServer, isStaff } from './permissions.js';
import {
  categoryConfirmation, confirmationRow, dossierCategory, dossierMenu, dossierPriority, dossierRoleSelector,
  IDS, internalNoteModal, internalNotesPage, progressModal, publicPanel, roleMessageModal, takeoverRow,
} from './ui.js';

const ephemeral = { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };

function ensureStaff(interaction, ticket, config) {
  if (!isStaff(interaction, ticket, config)) throw new UserError('Seule l’équipe autorisée peut effectuer cette action.');
}

function ensureCanClose(interaction, ticket, config) {
  if (ticket.ownerId !== interaction.user.id && !isStaff(interaction, ticket, config)) {
    throw new UserError('Seuls le créateur du ticket et l’équipe autorisée peuvent le fermer.');
  }
}

function ensureOpen(ticket) {
  if (ticket.status === 'closed') throw new UserError('Ce ticket est fermé.');
}

function ensureDossierAccess(interaction, ticket, config) {
  ensureStaff(interaction, ticket, config);
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ViewChannel)) {
    throw new UserError('Vous devez pouvoir voir ce salon pour gérer le dossier.');
  }
  ensureOpen(ticket);
  if (ticket.pendingReclassification) throw new UserError('Le changement de catégorie est interrompu. Prévenez un administrateur.');
}

const categoryVersion = (ticket) => ({ type: ticket.type, revision: ticket.categoryRevision ?? 0 });

function freshDossierAuthorization(interaction, config) {
  return async (ticket, channel) => {
    // L’action peut avoir attendu derrière un autre traitement : recharger
    // les rôles et le membre sous le verrou avant de consulter ou modifier.
    const [, member] = await Promise.all([
      interaction.guild.roles.fetch(),
      interaction.guild.members.fetch({ user: interaction.user.id, force: true }),
    ]);
    const permissions = member && channel.permissionsFor(member);
    if (!member || member.id !== interaction.user.id || !permissions?.has(PermissionFlagsBits.ViewChannel)
      || !isStaff({ member, memberPermissions: permissions }, ticket, config)) {
      throw new UserError('Vos droits ont changé : vous ne pouvez plus gérer ce dossier.');
    }
  };
}

function personalParts(interaction, prefix, extraParts = 0) {
  const parts = interaction.customId.slice(prefix.length).split(':');
  const [viewerId, ...rest] = parts;
  if (!/^\d{17,20}$/.test(viewerId) || viewerId !== interaction.user.id || rest.length !== extraParts) {
    throw new UserError('Ce menu est personnel ou a expiré. Rouvrez Gérer le dossier.');
  }
  return rest;
}

function categoryFromParts(type, revision) {
  if (!Object.hasOwn(TYPE_BY_KEY, type) || !/^\d{1,16}$/.test(revision) || !Number.isSafeInteger(Number(revision))) {
    throw new UserError('Cette action a expiré. Rouvrez Gérer le dossier.');
  }
  return { type, revision: Number(revision) };
}

function selectedValue(interaction) {
  if (interaction.values?.length !== 1) throw new UserError('Choisissez une seule option.');
  return interaction.values[0];
}

function feedback(result) {
  const introduction = result.unchanged ? 'Aucun changement' : 'Statut mis à jour';
  const nameInfo = result.ticket.renamePending ? ' Le nom du salon sera synchronisé dès que Discord le permettra.' : '';
  return `${introduction} : **${escapeMarkdown(statusLabel(result.ticket))}**.${nameInfo}${result.warning ? `\n⚠️ ${result.warning}` : ''}`;
}

async function askToClose(interaction) {
  await interaction.reply({
    content: '⚠️ Fermer supprimera définitivement ce salon et tous ses messages. Aucune transcription automatique n’est enregistrée. Continuer ?',
    components: [confirmationRow(IDS.closeDeleteConfirm)], ...ephemeral,
  });
}

async function reportClaim(interaction, result) {
  if (result.conflict) {
    await interaction.editReply({
      content: `Ce ticket est déjà attribué à <@${result.conflict}>. Voulez-vous le reprendre ?`,
      components: [takeoverRow(interaction.user.id, result.conflict, result.ticket.assignmentRevision ?? 0)], allowedMentions: { parse: [] },
    });
  } else {
    await interaction.editReply({ content: feedback(result), components: [], allowedMentions: { parse: [] } });
  }
}

async function reportError(interaction, error, logger) {
  if (!(error instanceof UserError)) logger.error('Erreur pendant une interaction Discord :', error);
  const content = error instanceof UserError
    ? error.message
    : 'Une erreur est survenue. Vérifiez les permissions du bot et consultez ses journaux.';
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({ content, ...ephemeral });
    }
  } catch (replyError) {
    logger.error('Impossible de répondre à l’interaction :', replyError);
  }
}

export function createInteractionHandler({ config, service, logger = console }) {
  const overviewLocks = new KeyedLock();

  async function handleDossier(interaction) {
    const id = interaction.customId;
    if (typeof id !== 'string') return false;
    const button = interaction.isButton();
    const select = interaction.isStringSelectMenu();
    const roleSelect = interaction.isRoleSelectMenu?.() ?? false;
    const modal = interaction.isModalSubmit();

    if (button && id === IDS.manage) {
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      await interaction.reply({ ...dossierMenu(ticket, interaction.user.id), ...ephemeral });
      return true;
    }
    if (button && id.startsWith(IDS.manageBack)) {
      personalParts(interaction, IDS.manageBack);
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      await interaction.update(dossierMenu(ticket, interaction.user.id));
      return true;
    }
    if (select && id.startsWith(IDS.manageMenu)) {
      personalParts(interaction, IDS.manageMenu);
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      const expectedCategory = categoryVersion(ticket);
      const action = selectedValue(interaction);
      if (action === 'priority') await interaction.update(dossierPriority(ticket, interaction.user.id));
      else if (action === 'category') await interaction.update(dossierCategory(ticket, interaction.user.id));
      else if (action === 'role') await interaction.update(dossierRoleSelector(interaction.user.id));
      else if (action === 'note-add') await interaction.showModal(internalNoteModal(ticket, interaction.user.id));
      else if (action === 'progress') {
        const modalId = `${IDS.manageProgressSubmit}${interaction.user.id}:${ticket.type}:${ticket.categoryRevision ?? 0}`;
        await interaction.showModal(progressModal(modalId));
      } else if (action === 'note-list') {
        await interaction.deferUpdate();
        const notes = await service.getInternalNotes(interaction.guild, interaction.channelId, { expectedCategory, authorize: freshDossierAuthorization(interaction, config) });
        await interaction.editReply(internalNotesPage(notes, interaction.user.id));
      } else if (['claim', 'waiting', 'resolve'].includes(action)) {
        await interaction.deferReply(ephemeral);
        const status = action === 'claim' ? 'claimed' : (action === 'waiting' ? 'waiting' : 'resolved');
        const result = await service.setStatus(interaction.guild, interaction.channelId, status, interaction.user.id, '', { expectedCategory, authorize: freshDossierAuthorization(interaction, config) });
        if (action === 'claim') await reportClaim(interaction, result);
        else await interaction.editReply({ content: feedback(result), allowedMentions: { parse: [] } });
      } else throw new UserError('Cette action n’existe pas. Rouvrez Gérer le dossier.');
      return true;
    }
    if (select && id.startsWith(IDS.managePriority)) {
      personalParts(interaction, IDS.managePriority);
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      const priority = selectedValue(interaction);
      if (!['normal', 'urgent'].includes(priority)) throw new UserError('Choisissez une priorité valide.');
      await interaction.deferUpdate();
      const result = await service.setUrgent(interaction.guild, interaction.channelId, priority === 'urgent', interaction.user.id, { expectedCategory: categoryVersion(ticket), authorize: freshDossierAuthorization(interaction, config) });
      const notice = `${result.unchanged ? 'Priorité inchangée' : 'Priorité mise à jour'} : ${result.ticket.urgent ? 'urgente' : 'normale'}.${result.warning ? `\n⚠️ ${result.warning}` : ''}`;
      await interaction.editReply(dossierMenu(result.ticket, interaction.user.id, notice));
      return true;
    }
    if (select && id.startsWith(IDS.manageCategory)) {
      personalParts(interaction, IDS.manageCategory);
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      const target = selectedValue(interaction);
      if (!Object.hasOwn(TYPE_BY_KEY, target)) throw new UserError('Choisissez une catégorie valide.');
      await interaction.update(target === ticket.type
        ? dossierMenu(ticket, interaction.user.id, 'La catégorie est inchangée.')
        : categoryConfirmation(ticket, interaction.user.id, target));
      return true;
    }
    if (button && id.startsWith(IDS.manageCategoryConfirm)) {
      const [type, revision, target] = personalParts(interaction, IDS.manageCategoryConfirm, 3);
      const expectedCategory = categoryFromParts(type, revision);
      if (!Object.hasOwn(TYPE_BY_KEY, target) || target === type) throw new UserError('Cette catégorie n’est plus valide.');
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      await interaction.deferUpdate();
      const result = await service.changeCategory(interaction.guild, interaction.channelId, target, interaction.user.id, { expectedCategory, authorize: freshDossierAuthorization(interaction, config) });
      const notice = `✅ Catégorie changée : ${TYPE_BY_KEY[target].label}. Le ticket est remis en attente.${result.warning ? `\n⚠️ ${result.warning}` : ''}`;
      if (isStaff(interaction, result.ticket, config)) await interaction.editReply(dossierMenu(result.ticket, interaction.user.id, notice));
      else await interaction.editReply({ content: `${notice}\nLa gestion est désormais réservée à l’équipe de cette catégorie.`, embeds: [], components: [], allowedMentions: { parse: [] } });
      return true;
    }
    if (button && id.startsWith(IDS.manageNotePage)) {
      const [rawPage, direction] = personalParts(interaction, IDS.manageNotePage, 2);
      if (!/^\d{1,3}$/.test(rawPage) || !['p', 'n'].includes(direction)) throw new UserError('Cette page n’est plus valide.');
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      await interaction.deferUpdate();
      const notes = await service.getInternalNotes(interaction.guild, interaction.channelId, { expectedCategory: categoryVersion(ticket), authorize: freshDossierAuthorization(interaction, config) });
      await interaction.editReply(internalNotesPage(notes, interaction.user.id, Number(rawPage)));
      return true;
    }
    if (modal && id.startsWith(IDS.manageNoteSubmit)) {
      const [type, revision] = personalParts(interaction, IDS.manageNoteSubmit, 2);
      const expectedCategory = categoryFromParts(type, revision);
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      const text = interaction.fields.getTextInputValue(IDS.noteInput);
      await interaction.deferReply(ephemeral);
      const result = await service.addInternalNote(interaction.guild, interaction.channelId, interaction.user.id, text, { expectedCategory, authorize: freshDossierAuthorization(interaction, config) });
      await interaction.editReply({ content: `✅ Note interne enregistrée (${result.count} au total). Elle n’a pas été publiée dans le salon.`, allowedMentions: { parse: [] } });
      return true;
    }
    if (modal && id.startsWith(IDS.manageProgressSubmit)) {
      const [type, revision] = personalParts(interaction, IDS.manageProgressSubmit, 2);
      const expectedCategory = categoryFromParts(type, revision);
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      const detail = interaction.fields.getTextInputValue(IDS.progressInput);
      await interaction.deferReply(ephemeral);
      const result = await service.setStatus(interaction.guild, interaction.channelId, 'progress', interaction.user.id, detail, { expectedCategory, authorize: freshDossierAuthorization(interaction, config) });
      await interaction.editReply({ content: feedback(result), allowedMentions: { parse: [] } });
      return true;
    }
    if (roleSelect && id.startsWith(IDS.manageRoleSelect)) {
      personalParts(interaction, IDS.manageRoleSelect);
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      const roleId = selectedValue(interaction);
      if (!/^\d{17,20}$/.test(roleId) || roleId === config.guildId) throw new UserError('Choisissez un rôle autre que @everyone.');
      await interaction.showModal(roleMessageModal(ticket, interaction.user.id, roleId));
      return true;
    }
    if (modal && id.startsWith(IDS.manageRoleSubmit)) {
      const [type, revision, roleId] = personalParts(interaction, IDS.manageRoleSubmit, 3);
      const expectedCategory = categoryFromParts(type, revision);
      const ticket = service.requireTicket(interaction.channelId);
      ensureDossierAccess(interaction, ticket, config);
      const text = interaction.fields.getTextInputValue(IDS.roleMessageInput);
      await interaction.deferReply(ephemeral);
      await service.notifyRole(interaction.guild, interaction.channelId, interaction.user.id, roleId, text, { expectedCategory, authorize: freshDossierAuthorization(interaction, config) });
      await interaction.editReply({ content: `✅ Message publié dans ce ticket pour <@&${roleId}>. Le rôle ne reçoit pas d’accès supplémentaire.`, allowedMentions: { parse: [] } });
      return true;
    }
    return false;
  }

  return async function handleInteraction(interaction) {
    // Aucune commande, sélection, modal ou bouton ne fonctionne ailleurs, même si
    // le bot a été invité par erreur sur un autre serveur ou reçoit un ancien bouton.
    if (interaction.guildId !== config.guildId) return;
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'panneau-tickets') {
          if (!canManageServer(interaction)) throw new UserError('Vous devez avoir la permission Gérer le serveur.');
          if (interaction.channel?.type !== ChannelType.GuildText) throw new UserError('Utilisez cette commande dans un salon textuel classique.');
          await interaction.deferReply(ephemeral);
          await interaction.channel.send(publicPanel());
          await interaction.editReply({ content: '✅ Panneau de tickets installé dans ce salon.' });
        } else if (interaction.commandName === 'ticket-panneau') {
          const ticket = service.requireTicket(interaction.channelId);
          ensureStaff(interaction, ticket, config);
          await interaction.deferReply(ephemeral);
          const message = await service.repair(interaction.guild, interaction.channelId, { expectedCategory: categoryVersion(ticket) });
          await interaction.editReply({ content: `✅ Panneau rétabli : ${message.url}\nLe nom du salon sera synchronisé dès que Discord le permettra.` });
        } else if (interaction.commandName === 'ticket-prendre') {
          const ticket = service.requireTicket(interaction.channelId);
          ensureStaff(interaction, ticket, config);
          ensureOpen(ticket);
          await interaction.deferReply(ephemeral);
          await reportClaim(interaction, await service.setStatus(interaction.guild, interaction.channelId, 'claimed', interaction.user.id, '', { expectedCategory: categoryVersion(ticket) }));
        } else if (interaction.commandName === 'ticket-fermer') {
          const ticket = service.requireTicket(interaction.channelId);
          ensureCanClose(interaction, ticket, config);
          ensureOpen(ticket);
          await askToClose(interaction);
        } else if (interaction.commandName === 'tickets') {
          const query = overviewQueryFromOptions(interaction.options, interaction.user.id);
          await interaction.deferReply(ephemeral);
          const payload = await renderOverview(interaction, config, service.store, query);
          await interaction.editReply(payload);
        }
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === IDS.open) {
        const type = interaction.values?.[0];
        if (interaction.values?.length !== 1 || !Object.hasOwn(TYPE_BY_KEY, type)) {
          throw new UserError('Choisissez une catégorie valide.');
        }
        await interaction.deferReply(ephemeral);
        const result = await service.open(interaction.guild, interaction.user, type);
        const content = result.created
          ? `✅ Votre ticket a été créé : <#${result.ticket.channelId}>.`
          : `Vous avez déjà un ticket ouvert dans cette catégorie : <#${result.ticket.channelId}>.`;
        await interaction.editReply({ content: `${content}${result.warning ? `\n⚠️ ${result.warning}` : ''}`, allowedMentions: { parse: [] } });
        return;
      }

      if (await handleDossier(interaction)) return;

      if (interaction.isModalSubmit() && interaction.customId === IDS.progressSubmit) {
        const ticket = service.requireTicket(interaction.channelId);
        ensureStaff(interaction, ticket, config);
        ensureOpen(ticket);
        const detail = interaction.fields.getTextInputValue(IDS.progressInput);
        await interaction.deferReply(ephemeral);
        const result = await service.setStatus(interaction.guild, interaction.channelId, 'progress', interaction.user.id, detail, { expectedCategory: categoryVersion(ticket) });
        await interaction.editReply({ content: feedback(result), allowedMentions: { parse: [] } });
        return;
      }

      if (!interaction.isButton()) return;
      if (isOverviewButton(interaction.customId)) {
        const { viewerId, query } = parseOverviewButton(interaction.customId);
        if (viewerId !== interaction.user.id) throw new UserError('Ce tableau est personnel. Utilisez /tickets pour ouvrir le vôtre.');
        await interaction.deferUpdate();
        // Deux clics rapprochés ne doivent pas afficher dans le désordre une vue
        // calculée avec d'anciennes permissions après une vue plus récente.
        const key = interaction.message?.id ?? `${interaction.guildId}:${interaction.user.id}`;
        await overviewLocks.run(key, async () => {
          try {
            const payload = await renderOverview(interaction, config, service.store, query);
            await interaction.editReply(payload);
          } catch (error) {
            await reportError(interaction, error, logger);
          }
        });
        return;
      }
      if (interaction.customId === IDS.cancel) {
        await interaction.update({ content: 'Action annulée.', components: [] });
        return;
      }
      if (interaction.customId?.startsWith(IDS.claimTakeover)) {
        const parts = interaction.customId.slice(IDS.claimTakeover.length).split(':');
        const [actorId, expectedAssignee, revision] = parts;
        if (parts.length !== 3 || !/^\d{17,20}$/.test(actorId) || !/^\d{17,20}$/.test(expectedAssignee)
          || !/^\d{1,16}$/.test(revision) || !Number.isSafeInteger(Number(revision))
          || actorId !== interaction.user.id) {
          throw new UserError('Cette confirmation ne vous appartient pas. Relancez la prise en charge.');
        }
        const ticket = service.requireTicket(interaction.channelId);
        ensureStaff(interaction, ticket, config);
        ensureOpen(ticket);
        await interaction.deferUpdate();
        const result = await service.setStatus(interaction.guild, interaction.channelId, 'claimed', actorId, '', {
          expectedAssignee, expectedAssignmentRevision: Number(revision), expectedCategory: categoryVersion(ticket),
          authorize: freshDossierAuthorization(interaction, config),
        });
        await reportClaim(interaction, result);
        return;
      }
      if (![IDS.claim, IDS.waiting, IDS.urgent, IDS.normal, IDS.progress, IDS.resolve, IDS.close,
        IDS.closeConfirm, IDS.closeDeleteConfirm, IDS.reopen, IDS.delete, IDS.deleteConfirm].includes(interaction.customId)) return;
      const ticket = service.requireTicket(interaction.channelId);

      if ([IDS.close, IDS.closeConfirm, IDS.closeDeleteConfirm].includes(interaction.customId)) {
        ensureCanClose(interaction, ticket, config);
        ensureOpen(ticket);
        if (interaction.customId === IDS.closeConfirm) {
          // Une confirmation de l'ancienne version annonçait une simple mise en
          // lecture seule : elle ne doit jamais déclencher une suppression.
          await interaction.update({
            content: 'Cette ancienne confirmation a expiré. Utilisez de nouveau Fermer : le salon sera désormais supprimé.', components: [],
          });
        } else if (interaction.customId === IDS.close) {
          await askToClose(interaction);
        } else {
          // Acquitter avant de supprimer le salon : on ne peut pas compter sur
          // une modification du message éphémère une fois le salon effacé.
          await interaction.update({ content: '⏳ Fermeture et suppression du salon et de ses messages…', components: [] });
          await service.close(interaction.guild, interaction.channelId, interaction.user.id, { expectedCategory: categoryVersion(ticket) });
        }
        return;
      }

      ensureStaff(interaction, ticket, config);
      if (interaction.customId === IDS.progress) {
        ensureOpen(ticket);
        await interaction.showModal(progressModal());
      } else if ([IDS.urgent, IDS.normal].includes(interaction.customId)) {
        ensureOpen(ticket);
        await interaction.deferReply(ephemeral);
        const result = await service.setUrgent(interaction.guild, interaction.channelId, interaction.customId === IDS.urgent, interaction.user.id, { expectedCategory: categoryVersion(ticket) });
        const label = result.ticket.urgent ? '🚨 Urgente' : 'Normale';
        await interaction.editReply({ content: `${result.unchanged ? 'Priorité inchangée' : 'Priorité mise à jour'} : **${label}**.${result.warning ? `\n⚠️ ${result.warning}` : ''}`, allowedMentions: { parse: [] } });
      } else if ([IDS.claim, IDS.waiting, IDS.resolve].includes(interaction.customId)) {
        ensureOpen(ticket);
        await interaction.deferReply(ephemeral);
        const status = interaction.customId === IDS.claim ? 'claimed' : (interaction.customId === IDS.waiting ? 'waiting' : 'resolved');
        const result = await service.setStatus(interaction.guild, interaction.channelId, status, interaction.user.id, '', { expectedCategory: categoryVersion(ticket) });
        if (status === 'claimed') await reportClaim(interaction, result);
        else await interaction.editReply({ content: feedback(result), allowedMentions: { parse: [] } });
      } else if (interaction.customId === IDS.reopen) {
        if (ticket.status !== 'closed') throw new UserError('Ce ticket n’est pas fermé.');
        await interaction.deferReply(ephemeral);
        const result = await service.reopen(interaction.guild, interaction.channelId, interaction.user.id, { expectedCategory: categoryVersion(ticket) });
        await interaction.editReply({ content: `✅ Ticket rouvert et remis en attente. Le nom du salon sera synchronisé dès que Discord le permettra.${result.warning ? `\n⚠️ ${result.warning}` : ''}` });
      } else if (interaction.customId === IDS.delete || interaction.customId === IDS.deleteConfirm) {
        if (ticket.status !== 'closed') throw new UserError('Utilisez Fermer pour supprimer ce ticket.');
        if (interaction.customId === IDS.delete) {
          await interaction.reply({
            content: 'Supprimer définitivement ce salon et tous ses messages ? Cette action est irréversible. Aucune transcription automatique n’est enregistrée.',
            components: [confirmationRow(IDS.deleteConfirm)], ...ephemeral,
          });
        } else {
          // Confirmer avant la suppression : une fois le salon supprimé, il n'est
          // plus toujours possible de modifier le message éphémère.
          await interaction.update({ content: '⏳ Suppression du salon et de ses messages…', components: [] });
          await service.delete(interaction.guild, interaction.channelId, interaction.user.id, { expectedCategory: categoryVersion(ticket) });
        }
      }
    } catch (error) {
      await reportError(interaction, error, logger);
    }
  };
}

import { ChannelType, MessageFlags, escapeMarkdown } from 'discord.js';
import { statusLabel, TYPE_BY_KEY } from './catalog.js';
import { UserError } from './errors.js';
import { KeyedLock } from './lock.js';
import { isOverviewButton, overviewQueryFromOptions, parseOverviewButton, renderOverview } from './overview.js';
import { canManageServer, isStaff } from './permissions.js';
import { confirmationRow, IDS, progressModal, publicPanel, takeoverRow } from './ui.js';

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
          const message = await service.repair(interaction.guild, interaction.channelId);
          await interaction.editReply({ content: `✅ Panneau rétabli : ${message.url}\nLe nom du salon sera synchronisé dès que Discord le permettra.` });
        } else if (interaction.commandName === 'ticket-prendre') {
          const ticket = service.requireTicket(interaction.channelId);
          ensureStaff(interaction, ticket, config);
          ensureOpen(ticket);
          await interaction.deferReply(ephemeral);
          await reportClaim(interaction, await service.setStatus(interaction.guild, interaction.channelId, 'claimed', interaction.user.id));
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

      if (interaction.isModalSubmit() && interaction.customId === IDS.progressSubmit) {
        const ticket = service.requireTicket(interaction.channelId);
        ensureStaff(interaction, ticket, config);
        ensureOpen(ticket);
        const detail = interaction.fields.getTextInputValue(IDS.progressInput);
        await interaction.deferReply(ephemeral);
        const result = await service.setStatus(interaction.guild, interaction.channelId, 'progress', interaction.user.id, detail);
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
          expectedAssignee, expectedAssignmentRevision: Number(revision),
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
          await service.close(interaction.guild, interaction.channelId, interaction.user.id);
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
        const result = await service.setUrgent(interaction.guild, interaction.channelId, interaction.customId === IDS.urgent, interaction.user.id);
        const label = result.ticket.urgent ? '🚨 Urgente' : 'Normale';
        await interaction.editReply({ content: `${result.unchanged ? 'Priorité inchangée' : 'Priorité mise à jour'} : **${label}**.${result.warning ? `\n⚠️ ${result.warning}` : ''}`, allowedMentions: { parse: [] } });
      } else if ([IDS.claim, IDS.waiting, IDS.resolve].includes(interaction.customId)) {
        ensureOpen(ticket);
        await interaction.deferReply(ephemeral);
        const status = interaction.customId === IDS.claim ? 'claimed' : (interaction.customId === IDS.waiting ? 'waiting' : 'resolved');
        const result = await service.setStatus(interaction.guild, interaction.channelId, status, interaction.user.id);
        if (status === 'claimed') await reportClaim(interaction, result);
        else await interaction.editReply({ content: feedback(result), allowedMentions: { parse: [] } });
      } else if (interaction.customId === IDS.reopen) {
        if (ticket.status !== 'closed') throw new UserError('Ce ticket n’est pas fermé.');
        await interaction.deferReply(ephemeral);
        const result = await service.reopen(interaction.guild, interaction.channelId, interaction.user.id);
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
          await service.delete(interaction.guild, interaction.channelId, interaction.user.id);
        }
      }
    } catch (error) {
      await reportError(interaction, error, logger);
    }
  };
}

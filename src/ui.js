import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown,
} from 'discord.js';
import { STATUSES, TICKET_TYPES, TYPE_BY_KEY, statusLabel, ticketNumber } from './catalog.js';

// Incrémenter si les boutons de gestion doivent être mis à jour sur les anciens tickets.
export const TICKET_PANEL_VERSION = 3;

export const IDS = Object.freeze({
  open: 'tickets:open',
  claim: 'ticket:claim',
  claimTakeover: 'ticket:claim:takeover:',
  waiting: 'ticket:waiting',
  urgent: 'ticket:urgent',
  normal: 'ticket:normal',
  progress: 'ticket:progress',
  progressSubmit: 'ticket:progress:submit',
  resolve: 'ticket:resolve',
  close: 'ticket:close',
  // L'ancien bouton promettait une fermeture sans suppression : ne pas le réutiliser.
  closeConfirm: 'ticket:close:confirm',
  closeDeleteConfirm: 'ticket:close:delete:confirm:v3',
  reopen: 'ticket:reopen',
  delete: 'ticket:delete',
  deleteConfirm: 'ticket:delete:confirm',
  cancel: 'ticket:cancel',
  progressInput: 'detail',
});

export function publicPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎫 Tickets • Madrid RP')
    .setDescription(
      'Besoin d’aide ? Choisissez le type de votre demande ci-dessous.\n' +
      'Un salon privé sera créé pour vous et l’équipe concernée. Merci d’y expliquer votre demande.\n' +
      'Fermer un ticket supprime définitivement le salon et ses messages après confirmation, sans transcription automatique.',
    )
    .addFields({
      name: 'Suivi des tickets',
      value: '🔴 En attente · 🟠 Pris en charge · 🟡 En cours · 🟢 Traité',
    })
    .setFooter({ text: 'Un ticket ouvert par type et par personne.' });
  const select = new StringSelectMenuBuilder()
    .setCustomId(IDS.open)
    .setPlaceholder('Choisissez une catégorie de ticket')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(TICKET_TYPES.map((type) => ({
      label: type.label, value: type.key, description: type.description, emoji: type.emoji,
    })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], allowedMentions: { parse: [] } };
}

export function ticketPanel(ticket) {
  const closed = ticket.status === 'closed';
  const embed = new EmbedBuilder()
    .setColor(STATUSES[ticket.status].color)
    .setTitle(`🎫 Ticket #${ticketNumber(ticket.number)} • ${TYPE_BY_KEY[ticket.type].label}`)
    .setDescription(closed
      ? 'Ancien ticket fermé avant la mise à jour. L’équipe peut le rouvrir ou supprimer définitivement son salon.'
      : 'Expliquez votre demande ici. Le suivi est réservé à l’équipe. Le créateur ou l’équipe peut fermer : le salon et ses messages seront supprimés.')
    .addFields(
      { name: 'Créateur', value: `<@${ticket.ownerId}>`, inline: true },
      { name: 'Statut', value: escapeMarkdown(statusLabel(ticket)), inline: true },
      { name: 'Responsable', value: ticket.assignedTo ? `<@${ticket.assignedTo}>` : 'Non attribué', inline: true },
      { name: 'Priorité', value: ticket.urgent ? '🚨 Urgente' : 'Normale', inline: true },
    )
    .setFooter({ text: ticket.renamePending
      ? '⏳ Nom du salon en attente de synchronisation avec Discord.'
      : (closed ? 'Ancien ticket fermé : le créateur conserve un accès en lecture seule.' : 'Le nom du salon indique aussi le statut du ticket.') })
    .setTimestamp(new Date(ticket.createdAt));

  const rows = closed
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.reopen).setLabel('Rouvrir l’ancien ticket').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.delete).setLabel('Supprimer le salon').setStyle(ButtonStyle.Danger),
    )]
    : [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.claim).setLabel(ticket.assignedTo ? 'Prendre / reprendre' : 'Prendre en charge').setEmoji('🟠').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(IDS.progress).setLabel('En cours de…').setEmoji('🟡').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.resolve).setLabel('Marquer traité').setEmoji('🟢').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(IDS.close).setLabel('Fermer').setEmoji('⚫').setStyle(ButtonStyle.Danger),
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.waiting).setLabel('Remettre en attente').setEmoji('🔴').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(ticket.urgent ? IDS.normal : IDS.urgent)
        .setLabel(ticket.urgent ? 'Retirer l’urgence' : 'Marquer urgent').setEmoji('🚨').setStyle(ButtonStyle.Secondary),
    )];
  return {
    content: `Bienvenue <@${ticket.ownerId}> ! Décrivez votre demande et patientez. Équipe concernée : ${ticket.staffRoleIds.map((id) => `<@&${id}>`).join(' ')}`,
    embeds: [embed], components: rows, allowedMentions: { parse: [] },
  };
}

export function initialTicketMessage(ticket) {
  return {
    ...ticketPanel(ticket),
    allowedMentions: { parse: [], users: [ticket.ownerId], roles: ticket.staffRoleIds },
  };
}

export function progressModal() {
  const input = new TextInputBuilder()
    .setCustomId(IDS.progressInput)
    .setLabel('En cours de quoi ?')
    .setPlaceholder('Ex. : vérification, enquête, réponse…')
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(40)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(IDS.progressSubmit)
    .setTitle('Mettre le ticket en cours')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

export function takeoverRow(actorId, previousId, revision) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${IDS.claimTakeover}${actorId}:${previousId}:${revision}`).setLabel('Reprendre ce ticket').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.cancel).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
  );
}

export function confirmationRow(confirmId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Confirmer').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(IDS.cancel).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
  );
}

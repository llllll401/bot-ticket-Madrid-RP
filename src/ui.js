import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown,
} from 'discord.js';
import { STATUSES, TICKET_TYPES, TYPE_BY_KEY, statusLabel, ticketNumber } from './catalog.js';
import { MAX_INTERNAL_NOTE_LENGTH, MAX_ROLE_MESSAGE_LENGTH } from './dossier.js';

// Incrémenter si les boutons de gestion doivent être mis à jour sur les anciens tickets.
export const TICKET_PANEL_VERSION = 5;

export const IDS = Object.freeze({
  open: 'tickets:open',
  manage: 'ticket:dossier',
  manageMenu: 'ticket:dossier:menu:',
  manageProgressSubmit: 'ticket:dossier:progress:',
  manageBack: 'ticket:dossier:back:',
  managePriority: 'ticket:dossier:priority:',
  manageCategory: 'ticket:dossier:category:',
  manageCategoryConfirm: 'ticket:dossier:move:',
  manageNoteSubmit: 'ticket:dossier:note:',
  manageNotePage: 'ticket:dossier:notes:',
  manageRoleSelect: 'ticket:dossier:role:',
  manageRoleSubmit: 'ticket:dossier:ping:',
  noteInput: 'note',
  roleMessageInput: 'message',
  assignmentToggle: 'ticket:assignment:',
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
      new ButtonBuilder()
        .setCustomId(`${IDS.assignmentToggle}${ticket.type}:${ticket.categoryRevision ?? 0}:${ticket.assignmentRevision ?? 0}`)
        .setLabel('Prendre en charge / laisser').setEmoji('🙋').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(IDS.manage).setLabel('Gérer le dossier').setEmoji('🗂️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(IDS.close).setLabel('Fermer').setEmoji('⚫').setStyle(ButtonStyle.Danger),
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

export function progressModal(customId = IDS.progressSubmit) {
  const input = new TextInputBuilder()
    .setCustomId(IDS.progressInput)
    .setLabel('En cours de quoi ?')
    .setPlaceholder('Ex. : vérification, enquête, réponse…')
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(40)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Mettre le ticket en cours')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

const backRow = (viewerId) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`${IDS.manageBack}${viewerId}`).setLabel('Retour au dossier').setStyle(ButtonStyle.Secondary),
);

export function dossierMenu(ticket, viewerId, notice = '') {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${IDS.manageMenu}${viewerId}`)
    .setPlaceholder('Choisir une action de gestion')
    .addOptions(
      { label: 'Prendre / reprendre', value: 'claim', emoji: '🟠' },
      { label: 'En cours de…', value: 'progress', emoji: '🟡' },
      { label: 'Marquer traité', value: 'resolve', emoji: '🟢' },
      { label: 'Remettre en attente', value: 'waiting', emoji: '🔴' },
      { label: 'Modifier la priorité', value: 'priority', emoji: '🚨' },
      { label: 'Changer la catégorie', value: 'category', emoji: '📂' },
      { label: 'Ajouter une note interne', value: 'note-add', emoji: '📝' },
      { label: 'Consulter les notes internes', value: 'note-list', emoji: '🔒' },
      { label: 'Contacter un rôle', value: 'role', emoji: '📣' },
    );
  const summary = `**Gestion du ticket #${ticketNumber(ticket.number)}** · ${TYPE_BY_KEY[ticket.type].label}\n`
    + `${escapeMarkdown(statusLabel(ticket))} · Priorité : ${ticket.urgent ? '🚨 urgente' : 'normale'} · Notes internes : ${(ticket.internalNotes ?? []).length}`;
  return { content: `${notice ? `${notice}\n\n` : ''}${summary}`, embeds: [], components: [new ActionRowBuilder().addComponents(select)], allowedMentions: { parse: [] } };
}

export function dossierPriority(ticket, viewerId) {
  const select = new StringSelectMenuBuilder().setCustomId(`${IDS.managePriority}${viewerId}`)
    .setPlaceholder('Choisir la priorité')
    .addOptions(
      { label: 'Normale', value: 'normal', default: !ticket.urgent },
      { label: 'Urgente', value: 'urgent', emoji: '🚨', default: Boolean(ticket.urgent) },
    );
  return { content: 'Choisissez la priorité du dossier.', embeds: [], components: [new ActionRowBuilder().addComponents(select), backRow(viewerId)], allowedMentions: { parse: [] } };
}

export function dossierCategory(ticket, viewerId) {
  const select = new StringSelectMenuBuilder().setCustomId(`${IDS.manageCategory}${viewerId}`)
    .setPlaceholder('Choisir le nouveau type de ticket')
    .addOptions(TICKET_TYPES.map((type) => ({ label: type.label, value: type.key, emoji: type.emoji, default: type.key === ticket.type })));
  return { content: 'Choisissez le nouveau type et sa catégorie Discord configurée.', embeds: [], components: [new ActionRowBuilder().addComponents(select), backRow(viewerId)], allowedMentions: { parse: [] } };
}

export function categoryConfirmation(ticket, viewerId, targetType) {
  const id = `${IDS.manageCategoryConfirm}${viewerId}:${ticket.type}:${ticket.categoryRevision ?? 0}:${targetType}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id).setLabel('Confirmer le changement').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${IDS.manageBack}${viewerId}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
  );
  return {
    content: `Passer de **${TYPE_BY_KEY[ticket.type].label}** à **${TYPE_BY_KEY[targetType].label}** ?\n`
      + 'Le salon sera déplacé, les rôles staff configurés seront remplacés, le responsable libéré et le ticket remis en attente. '
      + 'Vous pourriez perdre l’accès. Les accès ajoutés manuellement restent en place : vérifiez-les pour un dossier sensible.',
    embeds: [], components: [row], allowedMentions: { parse: [] },
  };
}

export function internalNoteModal(ticket, viewerId) {
  const input = new TextInputBuilder().setCustomId(IDS.noteInput).setLabel('Note privée pour le staff')
    .setPlaceholder('Enregistrée localement ; non publiée dans le salon.')
    .setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(MAX_INTERNAL_NOTE_LENGTH).setRequired(true);
  return new ModalBuilder().setCustomId(`${IDS.manageNoteSubmit}${viewerId}:${ticket.type}:${ticket.categoryRevision ?? 0}`)
    .setTitle('Ajouter une note interne').addComponents(new ActionRowBuilder().addComponents(input));
}

export function internalNotesPage(notes, viewerId, requestedPage = 0) {
  const pageSize = 2;
  const pages = Math.max(1, Math.ceil(notes.length / pageSize));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const recent = [...notes].reverse().slice(page * pageSize, (page + 1) * pageSize);
  const description = recent.length ? recent.map((note) => {
    const timestamp = Math.floor(Date.parse(note.createdAt) / 1000);
    return `**<@${note.authorId}> · <t:${timestamp}:f>**\n${escapeMarkdown(note.text)}`;
  }).join('\n\n') : 'Aucune note interne pour ce dossier.';
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🔒 Notes internes')
    .setDescription(description).setFooter({ text: `Page ${page + 1}/${pages} · Visible uniquement par le staff autorisé.` });
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${IDS.manageNotePage}${viewerId}:${Math.max(0, page - 1)}:p`).setLabel('Précédent').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${IDS.manageNotePage}${viewerId}:${Math.min(pages - 1, page + 1)}:n`).setLabel('Suivant').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId(`${IDS.manageBack}${viewerId}`).setLabel('Retour au dossier').setStyle(ButtonStyle.Secondary),
  );
  return { content: null, embeds: [embed], components: [controls], allowedMentions: { parse: [] } };
}

export function dossierRoleSelector(viewerId) {
  const select = new RoleSelectMenuBuilder().setCustomId(`${IDS.manageRoleSelect}${viewerId}`)
    .setPlaceholder('Choisir le rôle à contacter').setMinValues(1).setMaxValues(1);
  return {
    content: 'Le message sera publié dans ce ticket et visible par son créateur. Mentionner un rôle ne lui donne pas accès au salon.',
    embeds: [], components: [new ActionRowBuilder().addComponents(select), backRow(viewerId)], allowedMentions: { parse: [] },
  };
}

export function roleMessageModal(ticket, viewerId, roleId) {
  const input = new TextInputBuilder().setCustomId(IDS.roleMessageInput).setLabel('Message visible dans le ticket')
    .setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(MAX_ROLE_MESSAGE_LENGTH).setRequired(true);
  return new ModalBuilder().setCustomId(`${IDS.manageRoleSubmit}${viewerId}:${ticket.type}:${ticket.categoryRevision ?? 0}:${roleId}`)
    .setTitle('Contacter un rôle').addComponents(new ActionRowBuilder().addComponents(input));
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

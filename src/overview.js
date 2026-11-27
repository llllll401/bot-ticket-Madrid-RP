import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  PermissionFlagsBits, escapeMarkdown,
} from 'discord.js';
import { STATUSES, TICKET_TYPES, TYPE_BY_KEY, statusLabel, ticketNumber } from './catalog.js';
import { UserError } from './errors.js';
import { isStaff } from './permissions.js';

const PREFIX = 'tickets:overview:';
const SNOWFLAKE = /^\d{17,20}$/;
const PAGE_SIZE = 8;
const STATUS_ORDER = ['waiting', 'claimed', 'progress', 'resolved', 'closed'];
const STATUS_FILTERS = new Set(['active', ...STATUS_ORDER, 'all']);
const PRIORITY_FILTERS = new Set(['all', 'urgent', 'normal']);
const STATUS_LABELS = {
  active: 'tickets ouverts', waiting: 'en attente', claimed: 'pris en charge',
  progress: 'en cours', resolved: 'traités', closed: 'anciens tickets fermés', all: 'ouverts et anciens fermés',
};

function validateQuery(query) {
  if (!STATUS_FILTERS.has(query.status)
    || (query.type !== 'all' && !Object.hasOwn(TYPE_BY_KEY, query.type))
    || (!['all', 'none'].includes(query.assignee) && (typeof query.assignee !== 'string' || !SNOWFLAKE.test(query.assignee)))
    || !PRIORITY_FILTERS.has(query.priority)
    || !Number.isSafeInteger(query.page) || query.page < 0) {
    throw new UserError('Ces filtres ne sont plus valides. Relancez /tickets.');
  }
  return query;
}

export function overviewQueryFromOptions(options, viewerId) {
  const chosen = options.getUser('responsable')?.id ?? null;
  const mine = options.getBoolean('mes_tickets') ?? false;
  const unassigned = options.getBoolean('sans_responsable') ?? false;
  if (mine && chosen && chosen !== viewerId) {
    throw new UserError('Choisissez un responsable ou « mes_tickets », pas les deux pour des personnes différentes.');
  }
  if (unassigned && (mine || chosen)) {
    throw new UserError('« sans_responsable » ne peut pas être combiné avec un responsable.');
  }
  return validateQuery({
    status: options.getString('statut') ?? 'active',
    type: options.getString('categorie') ?? 'all',
    assignee: unassigned ? 'none' : (mine ? viewerId : (chosen ?? 'all')),
    priority: options.getString('priorite') ?? 'all',
    page: 0,
  });
}

function customId(viewerId, query, page, action) {
  return `${PREFIX}${viewerId}:${query.status}:${query.type}:${query.assignee}:${query.priority}:${page}:${action}`;
}

export function isOverviewButton(id) {
  return typeof id === 'string' && id.startsWith(PREFIX);
}

export function parseOverviewButton(id) {
  if (!isOverviewButton(id)) throw new UserError('Ce tableau n’est plus valide. Relancez /tickets.');
  const parts = id.slice(PREFIX.length).split(':');
  // Les tableaux éphémères affichés avant la mise à jour restent utilisables.
  if (parts.length === 6) parts.splice(4, 0, 'all');
  const [viewerId, status, type, assignee, priority, rawPage, action] = parts;
  if (parts.length !== 7 || !SNOWFLAKE.test(viewerId)
    || !/^\d{1,9}$/.test(rawPage) || !['p', 'r', 'n', 'u', 'a'].includes(action)) {
    throw new UserError('Ce tableau n’est plus valide. Relancez /tickets.');
  }
  const query = validateQuery({ status, type, assignee, priority, page: Number(rawPage) });
  return { viewerId, query };
}

// L'interaction est acquittée avant ces requêtes. On recharge le membre, les rôles
// et tous les salons (une seule requête par ressource, pas une par ticket).
// Si une vérification échoue, on ne renvoie aucune donnée du registre.
async function visibleTickets(interaction, config, store) {
  const guild = interaction.guild;
  if (!guild || guild.id !== config.guildId) throw new UserError('Ce serveur n’est pas autorisé.');
  const [, member] = await Promise.all([
    guild.roles.fetch(),
    guild.members.fetch({ user: interaction.user.id, force: true }),
  ]);
  if (!member || member.id !== interaction.user.id || !member.permissions) {
    throw new UserError('Impossible de vérifier vos permissions. Relancez /tickets.');
  }
  const identity = { member, memberPermissions: member.permissions };
  if (!TICKET_TYPES.some((type) => isStaff(identity, { type: type.key }, config))) {
    throw new UserError('Seule l’équipe autorisée peut consulter les tickets.');
  }
  const channels = await guild.channels.fetch();
  return store.list().filter((ticket) => {
    if (ticket.status === 'deleted' || !isStaff(identity, ticket, config)) return false;
    const channel = channels.get(ticket.channelId);
    return channel?.guildId === config.guildId && channel.type === ChannelType.GuildText
      && Boolean(channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel));
  });
}

function ticketLine(ticket) {
  // Les anciennes données peuvent contenir des retours à la ligne : elles ne
  // doivent pas casser la présentation ou produire du Markdown non échappé.
  const progressDetail = ticket.progressDetail?.replace(/\s+/g, ' ') ?? null;
  const label = escapeMarkdown(statusLabel({ ...ticket, progressDetail }));
  const updated = Math.max(0, Math.floor(Date.parse(ticket.updatedAt) / 1000));
  const responsible = ticket.assignedTo ? `<@${ticket.assignedTo}>` : 'personne';
  return `**${ticket.urgent ? '🚨 URGENT · ' : ''}${label} · #${ticketNumber(ticket.number)} · ${TYPE_BY_KEY[ticket.type].label}** — <#${ticket.channelId}>\n`
    + `Créateur : <@${ticket.ownerId}> · Responsable : ${responsible} · Statut modifié <t:${updated}:R>`;
}

export async function renderOverview(interaction, config, store, rawQuery) {
  const query = validateQuery(rawQuery);
  const visible = (await visibleTickets(interaction, config, store))
    .filter((ticket) => (query.type === 'all' || ticket.type === query.type)
      && (query.assignee === 'all' || (query.assignee === 'none' ? !ticket.assignedTo : ticket.assignedTo === query.assignee))
      && (query.priority === 'all' || Boolean(ticket.urgent) === (query.priority === 'urgent')));

  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const ticket of visible) counts[ticket.status]++;
  const filtered = visible.filter((ticket) => query.status === 'all'
    || (query.status === 'active' ? ticket.status !== 'closed' : ticket.status === query.status));
  filtered.sort((a, b) => Number(Boolean(b.urgent)) - Number(Boolean(a.urgent))
    || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.number - b.number);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(query.page, pages - 1);
  const items = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const countLine = STATUS_ORDER.map((status) => `${STATUSES[status].emoji} ${counts[status]}`).join(' · ');
  const typeLabel = query.type === 'all' ? 'toutes les catégories' : TYPE_BY_KEY[query.type].label;
  const assignedLabel = query.assignee === 'all' ? '' : (query.assignee === 'none'
    ? ' · sans responsable' : (query.assignee === interaction.user.id ? ' · attribués à vous' : ` · responsable : <@${query.assignee}>`));
  const priorityLabel = query.priority === 'all' ? '' : (query.priority === 'urgent' ? ' · urgents' : ' · priorité normale');
  const scope = `${STATUS_LABELS[query.status]} · ${typeLabel}${assignedLabel}${priorityLabel}`;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎫 Suivi des tickets')
    .setDescription(`**Filtres :** ${scope}\n**Tickets visibles :** ${countLine}\n**Résultats :** ${filtered.length}\n\n`
      + (items.length ? items.map(ticketLine).join('\n\n') : 'Aucun ticket visible avec ces filtres.'))
    .setFooter({ text: `Page ${page + 1}/${pages} • Urgents d’abord, puis attentes les plus anciennes.` });
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId(interaction.user.id, query, Math.max(0, page - 1), 'p'))
      .setLabel('Précédent').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(customId(interaction.user.id, query, page, 'r'))
      .setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId(interaction.user.id, query, Math.min(pages - 1, page + 1), 'n'))
      .setLabel('Suivant').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId(customId(interaction.user.id, { ...query, priority: query.priority === 'urgent' ? 'all' : 'urgent' }, 0, 'u'))
      .setLabel(query.priority === 'urgent' ? 'Toutes priorités' : 'Urgents').setEmoji('🚨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(customId(interaction.user.id, { ...query, assignee: query.assignee === 'none' ? 'all' : 'none' }, 0, 'a'))
      .setLabel(query.assignee === 'none' ? 'Tous responsables' : 'Sans responsable').setStyle(ButtonStyle.Secondary),
  );
  return { content: null, embeds: [embed], components: [controls], allowedMentions: { parse: [] } };
}

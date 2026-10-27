import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { TICKET_TYPES } from './catalog.js';

export const STAFF_ACCESS = Object.freeze({
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  EmbedLinks: true,
  AttachFiles: true,
});

// Ces permissions sont nécessaires à la création, à la gestion et à la fermeture
// en lecture seule, y compris lorsque des fils existent dans le ticket.
export const REQUIRED_BOT_PERMISSIONS = Object.freeze({
  'Voir les salons': PermissionFlagsBits.ViewChannel,
  'Gérer les salons': PermissionFlagsBits.ManageChannels,
  'Gérer les rôles': PermissionFlagsBits.ManageRoles,
  'Envoyer des messages': PermissionFlagsBits.SendMessages,
  'Lire l’historique': PermissionFlagsBits.ReadMessageHistory,
  'Intégrer des liens': PermissionFlagsBits.EmbedLinks,
  'Joindre des fichiers': PermissionFlagsBits.AttachFiles,
  'Créer des fils publics': PermissionFlagsBits.CreatePublicThreads,
  'Créer des fils privés': PermissionFlagsBits.CreatePrivateThreads,
  'Envoyer dans les fils': PermissionFlagsBits.SendMessagesInThreads,
});

export const OWNER_WRITE_PERMISSIONS = Object.freeze([
  'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads',
]);

export function isStaff(interaction, ticket, config) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roles = interaction.member?.roles;
  const configured = config.staffRolesByType[ticket.type] ?? [];
  return configured.some((roleId) =>
    Array.isArray(roles) ? roles.includes(roleId) : Boolean(roles?.cache?.has(roleId)));
}

export function canManageServer(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

export function ticketOverwrites(guildId, botId, ownerId, staffRoleIds) {
  const staffAllows = Object.keys(STAFF_ACCESS).map((name) => PermissionFlagsBits[name]);
  return [
    { id: guildId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ownerId, type: OverwriteType.Member, allow: staffAllows },
    ...staffRoleIds.map((id) => ({ id, type: OverwriteType.Role, allow: staffAllows })),
    { id: botId, type: OverwriteType.Member, allow: Object.values(REQUIRED_BOT_PERMISSIONS) },
  ];
}

export function snapshotOwnerWrites(channel, ownerId) {
  const overwrite = channel.permissionOverwrites.cache.get(ownerId);
  return Object.fromEntries(OWNER_WRITE_PERMISSIONS.map((name) => {
    const flag = PermissionFlagsBits[name];
    if (overwrite?.allow.has(flag, false)) return [name, true];
    if (overwrite?.deny.has(flag, false)) return [name, false];
    return [name, null];
  }));
}

export function closedOwnerWrites() {
  return Object.fromEntries(OWNER_WRITE_PERMISSIONS.map((name) => [name, false]));
}

export async function validateGuildConfiguration(guild, config) {
  if (guild.id !== config.guildId) throw new Error('Le serveur Discord ne correspond pas à serveurId dans config.json.');
  const me = await guild.members.fetchMe({ force: true });
  const missing = Object.entries(REQUIRED_BOT_PERMISSIONS)
    .filter(([, bit]) => !me.permissions.has(bit))
    .map(([name]) => name);
  if (missing.length) throw new Error(`Permissions manquantes pour le bot : ${missing.join(', ')}.`);

  const roleIds = new Set(Object.values(config.staffRolesByType).flat());
  for (const roleId of roleIds) {
    const role = await guild.roles.fetch(roleId, { force: true });
    if (!role) throw new Error(`Rôle staff introuvable sur le serveur : ${roleId}.`);
  }
  const categoryIds = new Set();
  for (const type of TICKET_TYPES) {
    const categoryId = config.categoryIdsByType[type.key];
    if (!categoryId) throw new Error(`ID de catégorie manquant pour ${type.label} dans config.json.`);
    categoryIds.add(categoryId);
  }
  for (const categoryId of categoryIds) {
    let category;
    try {
      category = await guild.channels.fetch(categoryId, { force: true });
    } catch (error) {
      if (Number(error?.code) !== 10003) throw error;
    }
    if (!category || category.guildId !== config.guildId || category.type !== ChannelType.GuildCategory) {
      throw new Error(`La catégorie Discord ${categoryId} est introuvable ou n’est pas une catégorie de ce serveur.`);
    }
  }
}

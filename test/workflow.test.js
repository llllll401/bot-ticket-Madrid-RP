import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField, RateLimitError } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { createInteractionHandler } from '../src/interactions.js';
import { closedOwnerWrites, snapshotOwnerWrites } from '../src/permissions.js';
import { TicketStore } from '../src/store.js';
import { TicketService } from '../src/ticket-service.js';
import { IDS } from '../src/ui.js';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const OWNER = '110000000000000001';
const STRANGER = '110000000000000002';
const STAFF = '110000000000000003';
const BOT = '110000000000000004';
const ROLE = '200000000000000001';
const SPECIAL_ROLE = '200000000000000002';
const NEW_ROLE = '200000000000000003';
const PARENT = '300000000000000001';
const CATEGORIES = Object.freeze({
  plainte: PARENT,
  question: '300000000000000002',
  rc_staff: '300000000000000003',
  demande_unban: '300000000000000004',
  fondation: '300000000000000005',
  partenariat: '300000000000000006',
});
const silentLogger = { error() {} };
let channelCounter = 400000000000000000n;
let messageCounter = 500000000000000000n;
const nextChannel = () => String(++channelCounter);
const nextMessage = () => String(++messageCounter);
const apiError = (code) => Object.assign(new Error(`Discord ${code}`), { code });

class FakeChannel {
  constructor(guild, options = {}) {
    this.guild = guild;
    this.guildId = guild.id;
    this.id = options.id ?? nextChannel();
    this.name = options.name ?? 'tickets';
    this.type = options.type ?? ChannelType.GuildText;
    this.parentId = options.parent ?? null;
    this.topic = options.topic ?? null;
    this.sent = [];
    this.permissionEvents = [];
    this.renameAttempts = [];
    this.messageMap = new Map();
    this.messages = {
      fetch: async (id) => {
        const message = this.messageMap.get(id);
        if (!message) throw apiError(10008);
        return message;
      },
    };
    const cache = new Map();
    for (const overwrite of options.permissionOverwrites ?? []) {
      cache.set(overwrite.id, {
        allow: new PermissionsBitField(overwrite.allow ?? []),
        deny: new PermissionsBitField(overwrite.deny ?? []),
      });
    }
    this.permissionOverwrites = {
      cache,
      edit: async (id, values) => {
        this.permissionEvents.push(`edit:${id}`);
        if (this.failPermissionEdit) throw new Error('permission refusée');
        const current = cache.get(id) ?? { allow: new PermissionsBitField(), deny: new PermissionsBitField() };
        for (const [name, value] of Object.entries(values)) {
          const bit = PermissionFlagsBits[name];
          current.allow.remove(bit);
          current.deny.remove(bit);
          if (value === true) current.allow.add(bit);
          if (value === false) current.deny.add(bit);
        }
        cache.set(id, current);
        return this;
      },
      delete: async (id) => {
        this.permissionEvents.push(`delete:${id}`);
        if (this.failPermissionDelete) throw new Error('suppression de permission refusée');
        cache.delete(id); return this;
      },
    };
  }

  async send(payload) {
    if (this.failSend) throw new Error('envoi impossible');
    const message = {
      id: nextMessage(),
      url: `https://discord.com/channels/${this.guildId}/${this.id}/${messageCounter}`,
      payload,
      failEdit: false,
      edit: async (next) => {
        if (message.failEdit) throw new Error('modification impossible');
        message.payload = next;
        return message;
      },
    };
    this.sent.push(message);
    this.messageMap.set(message.id, message);
    return message;
  }

  async setName(name) {
    this.renameAttempts.push(name);
    if (this.rateLimitDelay) {
      throw new RateLimitError({ route: '/channels/:id', method: 'PATCH', retryAfter: this.rateLimitDelay, sublimitTimeout: this.rateLimitDelay });
    }
    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error('renommage impossible');
    }
    if (this.renameGate) {
      const gate = this.renameGate;
      this.renameGate = null;
      this.onRenameStart?.();
      await gate;
    }
    this.name = name;
    return this;
  }

  async edit(options) {
    this.channelEditOptions = options;
    if (this.editGate) {
      const gate = this.editGate;
      this.editGate = null;
      this.onEditStart?.();
      await gate;
    }
    if (this.failChannelEdit) throw this.failChannelEdit;
    if (options.parent !== undefined) this.parentId = options.parent;
    if (options.topic !== undefined) this.topic = options.topic;
    return this;
  }

  permissionsFor(member) {
    if (member.id === BOT) return new PermissionsBitField(this.botPermissions ?? []);
    return member.channelPermissions ?? member.permissions;
  }

  async delete() {
    if (this.failDelete) throw new Error('suppression impossible');
    this.deleted = true;
    this.guild.channelMap.delete(this.id);
    return this;
  }
}

function makeGuild() {
  const guild = { id: GUILD, channelMap: new Map(), roleMap: new Map(), memberMap: new Map(), createCount: 0 };
  for (const id of [ROLE, SPECIAL_ROLE, NEW_ROLE]) guild.roleMap.set(id, { id, guild, mentionable: true });
  guild.roles = { fetch: async (id) => id ? (guild.roleMap.get(id) ?? null) : guild.roleMap };
  guild.members = {
    fetchMe: async () => ({ id: BOT }),
    fetch: async ({ user }) => guild.memberMap.get(user) ?? null,
  };
  guild.channels = {
    create: async (options) => {
      guild.createCount++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const channel = new FakeChannel(guild, options);
      guild.channelMap.set(channel.id, channel);
      return channel;
    },
    fetch: async (id) => {
      if (!id) return new Map(guild.channelMap);
      const channel = guild.channelMap.get(id);
      if (!channel) throw apiError(10003);
      return channel;
    },
  };
  return guild;
}

function interaction(guild, options = {}) {
  const kind = options.kind ?? 'button';
  const channel = options.channel ?? new FakeChannel(guild, { name: 'accueil' });
  const roles = new Set(options.roles ?? []);
  const userId = options.userId ?? OWNER;
  guild.memberMap.set(userId, {
    id: userId,
    roles: { cache: new Set(options.freshRoles ?? options.roles ?? []) },
    permissions: new PermissionsBitField(options.freshPermissions ?? options.permissions ?? []),
  });
  const item = {
    guild,
    guildId: options.guildId ?? guild.id,
    channel,
    channelId: channel.id,
    user: { id: options.userId ?? OWNER, username: options.username ?? 'Élodie', globalName: null },
    member: { roles: { cache: roles } },
    memberPermissions: new PermissionsBitField(options.permissions ?? []),
    customId: options.customId,
    commandName: options.commandName,
    values: options.values,
    fields: { getTextInputValue: () => options.detail },
    deferred: false,
    replied: false,
    response: null,
    modal: null,
    isChatInputCommand: () => kind === 'command',
    isStringSelectMenu: () => kind === 'select',
    isRoleSelectMenu: () => kind === 'role-select',
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    async reply(payload) { this.replied = true; this.response = payload; },
    async deferReply(payload) { this.deferred = true; this.deferOptions = payload; },
    async editReply(payload) { this.response = { ...this.response, ...payload }; },
    async deferUpdate() { this.deferred = true; },
    async update(payload) { this.replied = true; this.response = payload; },
    async showModal(modal) { this.replied = true; this.modal = modal.toJSON(); },
  };
  return item;
}

function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madrid-tickets-flow-'));
  let service;
  t.after(() => { service?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const rawConfig = {
    token: 'fake-token', serveurId: GUILD, rolesStaff: [ROLE],
    categories: { ...CATEGORIES }, rolesStaffParCategorie: {}, ...overrides,
  };
  const config = loadConfig(rawConfig, dir);
  const store = new TicketStore(config.dataFile, GUILD);
  const guild = makeGuild();
  service = new TicketService({ config, store, botUserId: BOT, logger: silentLogger });
  const handle = createInteractionHandler({ config, service, logger: silentLogger });
  return { config, store, guild, service, handle, rawConfig };
}

async function openTicket(h, type = 'plainte', userId = OWNER) {
  const item = interaction(h.guild, { kind: 'select', customId: IDS.open, values: [type], userId });
  await h.handle(item);
  const ticket = h.store.findOpen(userId, type);
  return { item, ticket, channel: ticket ? h.guild.channelMap.get(ticket.channelId) : null };
}

async function press(h, channel, customId, options = {}) {
  const item = interaction(h.guild, { channel, customId, ...options });
  await h.handle(item);
  return item;
}

const staffAccess = { userId: STAFF, roles: [ROLE], permissions: [PermissionFlagsBits.ViewChannel] };

function assignmentButton(h, channel) {
  const ticket = h.store.get(channel.id);
  const panel = channel.messageMap.get(ticket.panelMessageId).payload;
  return panel.components.flatMap((row) => row.toJSON().components)
    .find((component) => component.custom_id.startsWith(IDS.assignmentToggle));
}

async function choose(h, channel, customId, value, options = {}) {
  const item = interaction(h.guild, { kind: 'select', channel, customId, values: [value], ...staffAccess, ...options });
  await h.handle(item);
  return item;
}

async function manageAction(h, channel, action, options = {}) {
  const viewerId = options.userId ?? STAFF;
  return choose(h, channel, `${IDS.manageMenu}${viewerId}`, action, options);
}

// Simule un ticket fermé avant la mise à jour, avec ses permissions d'origine.
async function makeLegacyClosed(h, channel) {
  const ticket = h.store.get(channel.id);
  const previous = snapshotOwnerWrites(channel, ticket.ownerId);
  await channel.permissionOverwrites.edit(ticket.ownerId, closedOwnerWrites());
  const timestamp = new Date().toISOString();
  return h.store.save({
    ...ticket, status: 'closed', progressDetail: null, closedAt: timestamp,
    closedPermissions: previous, updatedAt: timestamp, panelVersion: 2,
  });
}

function permission(channel, userId, name) {
  const overwrite = channel.permissionOverwrites.cache.get(userId);
  const bit = PermissionFlagsBits[name];
  if (overwrite?.allow.has(bit, false)) return true;
  if (overwrite?.deny.has(bit, false)) return false;
  return null;
}

async function waitUntil(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Délai dépassé pendant le test.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForName(store, channel) {
  await waitUntil(() => !store.get(channel.id)?.renamePending);
}

test('serveur unique et installation du panneau protégée', async (t) => {
  const h = harness(t);
  const outsider = interaction(h.guild, { kind: 'select', guildId: OTHER_GUILD, customId: IDS.open, values: ['plainte'] });
  await h.handle(outsider);
  assert.equal(outsider.response, null);
  assert.equal(h.guild.createCount, 0);

  const panelChannel = new FakeChannel(h.guild);
  const denied = interaction(h.guild, { kind: 'command', channel: panelChannel, commandName: 'panneau-tickets' });
  await h.handle(denied);
  assert.match(denied.response.content, /Gérer le serveur/);
  assert.equal(panelChannel.sent.length, 0);
  const allowed = interaction(h.guild, { kind: 'command', channel: panelChannel, commandName: 'panneau-tickets', permissions: [PermissionFlagsBits.ManageGuild] });
  await h.handle(allowed);
  assert.match(allowed.response.content, /installé/);
  assert.equal(panelChannel.sent[0].payload.components[0].toJSON().components[0].options.length, 6);
});

test('les ouvertures simultanées ne créent qu’un salon privé par utilisateur et par type', async (t) => {
  const h = harness(t);
  const first = interaction(h.guild, { kind: 'select', customId: IDS.open, values: ['plainte'] });
  const second = interaction(h.guild, { kind: 'select', customId: IDS.open, values: ['plainte'] });
  await Promise.all([h.handle(first), h.handle(second)]);
  assert.ok(first.deferred && second.deferred);
  assert.equal(h.guild.createCount, 1);
  assert.match(first.response.content, /créé/);
  assert.match(second.response.content, /déjà un ticket/);
  const ticket = h.store.findOpen(OWNER, 'plainte');
  const channel = h.guild.channelMap.get(ticket.channelId);
  assert.equal(channel.parentId, PARENT);
  assert.equal(permission(channel, GUILD, 'ViewChannel'), false);
  assert.equal(permission(channel, OWNER, 'ViewChannel'), true);
  assert.equal(permission(channel, ROLE, 'ViewChannel'), true);
  assert.equal(permission(channel, BOT, 'ViewChannel'), true);
  assert.equal(channel.permissionOverwrites.cache.has(STRANGER), false);
  const question = await openTicket(h, 'question');
  assert.ok(question.ticket);
  assert.equal(question.channel.parentId, CATEGORIES.question);
  assert.equal(h.guild.createCount, 2);
  const invalid = interaction(h.guild, { kind: 'select', customId: IDS.open, values: ['toString'] });
  await h.handle(invalid);
  assert.match(invalid.response.content, /catégorie valide/);
  assert.equal(h.guild.createCount, 2);
});

test('prise en charge, étape, traitement et fermeture par suppression confirmée', async (t) => {
  const h = harness(t);
  const { channel, ticket } = await openTicket(h);
  const denied = await press(h, channel, IDS.claim, { userId: STRANGER });
  assert.match(denied.response.content, /Seule l’équipe/);
  assert.equal(h.store.get(channel.id).status, 'waiting');

  const claim = await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  assert.match(claim.response.content, /Pris en charge/);
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🟠-pris-en-charge-/u);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);

  const modalButton = await press(h, channel, IDS.progress, { userId: STAFF, roles: [ROLE] });
  assert.equal(modalButton.modal.custom_id, IDS.progressSubmit);
  const modal = interaction(h.guild, { kind: 'modal', channel, customId: IDS.progressSubmit, userId: STAFF, roles: [ROLE], detail: 'Vérification des preuves' });
  await h.handle(modal);
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🟡-en-cours-de-verification-des-preuves-/u);
  assert.equal(h.store.get(channel.id).progressDetail, 'Vérification des preuves');
  const panel = channel.messageMap.get(ticket.panelMessageId);
  assert.match(panel.payload.embeds[0].toJSON().fields[1].value, /En cours de Vérification des preuves/);

  await press(h, channel, IDS.resolve, { userId: STAFF, roles: [ROLE] });
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🟢-traite-/u);
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, channel.id);
  const duplicate = await openTicket(h);
  assert.match(duplicate.item.response.content, /déjà un ticket/);

  const confirmation = await press(h, channel, IDS.close, { userId: OWNER });
  assert.match(confirmation.response.content, /définitivement.*salon.*tous ses messages/);
  assert.match(confirmation.response.content, /Aucune transcription/);
  assert.equal(h.store.get(channel.id).status, 'resolved');
  assert.equal(confirmation.response.components[0].toJSON().components[0].custom_id, IDS.closeDeleteConfirm);
  const stale = await press(h, channel, IDS.closeConfirm, { userId: OWNER });
  assert.match(stale.response.content, /ancienne confirmation.*expiré/);
  assert.equal(h.store.get(channel.id).status, 'resolved');
  assert.equal(h.guild.channelMap.has(channel.id), true);
  const deleting = interaction(h.guild, { channel, customId: IDS.closeDeleteConfirm, userId: OWNER });
  const deleteChannel = channel.delete.bind(channel);
  channel.delete = async () => {
    assert.equal(deleting.replied, true, 'L’interaction doit être acquittée avant la suppression.');
    assert.equal(h.store.get(channel.id).pendingDeletion.actorId, OWNER);
    assert.ok(h.store.findOpen(OWNER, 'plainte'), 'Le verrou d’unicité reste actif avant confirmation par Discord.');
    return deleteChannel();
  };
  await h.handle(deleting);
  assert.match(deleting.response.content, /suppression du salon/);
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.store.get(channel.id).closedBy, OWNER);
  assert.equal(h.store.get(channel.id).deletedBy, OWNER);
  assert.equal(h.store.get(channel.id).deletionRequestedAt, h.store.get(channel.id).closedAt);
  assert.ok(h.store.get(channel.id).closedAt);
  assert.equal(h.store.get(channel.id).pendingDeletion, null);
  assert.equal(h.guild.channelMap.has(channel.id), false);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
  const replacement = await openTicket(h);
  assert.notEqual(replacement.channel.id, channel.id);
});

test('les anciens tickets fermés peuvent être rouverts avec leurs permissions précédentes', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await channel.permissionOverwrites.edit(OWNER, { SendMessagesInThreads: true, CreatePublicThreads: false, CreatePrivateThreads: null });
  const legacy = await makeLegacyClosed(h, channel);
  h.store.save({ ...legacy, closedBy: STAFF });
  await h.service.refreshOutdatedPanels(h.guild);
  assert.equal(h.guild.channelMap.has(channel.id), true, 'La migration ne supprime jamais les anciens salons fermés.');
  assert.equal(h.store.get(channel.id).status, 'closed');
  const upgraded = channel.messageMap.get(h.store.get(channel.id).panelMessageId).payload;
  assert.deepEqual(upgraded.components.flatMap((row) => row.toJSON().components).map((button) => button.custom_id), [IDS.reopen, IDS.delete]);
  for (const name of ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads']) {
    assert.equal(permission(channel, OWNER, name), false);
  }
  assert.equal(permission(channel, OWNER, 'ViewChannel'), true);
  const ownerReopen = await press(h, channel, IDS.reopen, { userId: OWNER });
  assert.match(ownerReopen.response.content, /Seule l’équipe/);
  const staffReopen = await press(h, channel, IDS.reopen, { userId: STAFF, roles: [ROLE] });
  assert.match(staffReopen.response.content, /rouvert/);
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🔴-attente-/u);
  assert.equal(h.store.get(channel.id).assignedTo, null);
  assert.equal(h.store.get(channel.id).closedBy, null);
  assert.equal(permission(channel, OWNER, 'SendMessages'), true);
  assert.equal(permission(channel, OWNER, 'SendMessagesInThreads'), true);
  assert.equal(permission(channel, OWNER, 'CreatePublicThreads'), false);
  assert.equal(permission(channel, OWNER, 'CreatePrivateThreads'), null);
  await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.equal(h.store.get(channel.id).closedBy, OWNER);
});

test('réouverture sans doublon et suppression explicite des anciens tickets uniquement par le staff', async (t) => {
  const h = harness(t);
  const old = await openTicket(h);
  await makeLegacyClosed(h, old.channel);
  const newer = await openTicket(h);
  assert.notEqual(newer.channel.id, old.channel.id);
  const reopen = await press(h, old.channel, IDS.reopen, { userId: STAFF, roles: [ROLE] });
  assert.match(reopen.response.content, /Un autre ticket.*déjà ouvert/);
  assert.equal(h.store.get(old.channel.id).status, 'closed');
  const openDelete = await press(h, newer.channel, IDS.deleteConfirm, { userId: STAFF, roles: [ROLE] });
  assert.match(openDelete.response.content, /Utilisez Fermer/);
  const unauthorized = await press(h, old.channel, IDS.deleteConfirm, { userId: OWNER });
  assert.match(unauthorized.response.content, /Seule l’équipe/);
  const ask = await press(h, old.channel, IDS.delete, { userId: STAFF, roles: [ROLE] });
  assert.match(ask.response.content, /irréversible/);
  assert.ok(h.guild.channelMap.has(old.channel.id));
  await press(h, old.channel, IDS.deleteConfirm, { userId: STAFF, roles: [ROLE] });
  assert.equal(h.guild.channelMap.has(old.channel.id), false);
  assert.equal(h.store.get(old.channel.id).status, 'deleted');
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, newer.channel.id);
});

test('les tickets et boutons survivent au redémarrage et les salons supprimés sont détectés', async (t) => {
  const h = harness(t);
  const first = await openTicket(h);
  h.service.stop();
  const reloadedStore = new TicketStore(h.config.dataFile, GUILD);
  const reloadedService = new TicketService({ config: h.config, store: reloadedStore, botUserId: BOT, logger: silentLogger });
  t.after(() => reloadedService.stop());
  const reloadedHandler = createInteractionHandler({ config: h.config, service: reloadedService, logger: silentLogger });
  const claim = interaction(h.guild, { channel: first.channel, customId: IDS.claim, userId: STAFF, roles: [ROLE] });
  await reloadedHandler(claim);
  assert.equal(reloadedStore.get(first.channel.id).status, 'claimed');

  // Simule un salon supprimé pendant que le bot était hors ligne.
  h.guild.channelMap.delete(first.channel.id);
  const select = interaction(h.guild, { kind: 'select', customId: IDS.open, values: ['plainte'] });
  await reloadedHandler(select);
  assert.match(select.response.content, /créé/);
  assert.equal(reloadedStore.get(first.channel.id).status, 'deleted');
  const replacement = reloadedStore.findOpen(OWNER, 'plainte');
  assert.notEqual(replacement.channelId, first.channel.id);
  await reloadedService.channelDeleted({ id: replacement.channelId, guildId: OTHER_GUILD });
  assert.ok(reloadedStore.findOpen(OWNER, 'plainte'));
  await reloadedService.channelDeleted(h.guild.channelMap.get(replacement.channelId));
  assert.equal(reloadedStore.get(replacement.channelId).status, 'deleted');
});

test('les rôles spécifiques remplacent les rôles généraux et sont synchronisés après changement', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const { channel } = await openTicket(h, 'rc_staff');
  assert.equal(permission(channel, SPECIAL_ROLE, 'ViewChannel'), true);
  assert.equal(channel.permissionOverwrites.cache.has(ROLE), false);
  const wrongStaff = await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  assert.match(wrongStaff.response.content, /Seule l’équipe/);
  const allowed = await press(h, channel, IDS.claim, { userId: STAFF, roles: [SPECIAL_ROLE] });
  assert.match(allowed.response.content, /Pris en charge/);
  await waitForName(h.store, channel);
  h.service.stop();

  const newConfig = loadConfig({ ...h.rawConfig, rolesStaffParCategorie: { ...h.rawConfig.rolesStaffParCategorie, rc_staff: [NEW_ROLE] } }, path.dirname(path.dirname(h.config.dataFile)));
  const restarted = new TicketService({ config: newConfig, store: h.store, botUserId: BOT, logger: silentLogger });
  t.after(() => restarted.stop());
  await restarted.syncConfiguredRoles(h.guild);
  assert.equal(channel.permissionOverwrites.cache.has(SPECIAL_ROLE), false);
  assert.equal(permission(channel, NEW_ROLE, 'ViewChannel'), true);
  assert.deepEqual(h.store.get(channel.id).staffRoleIds, [NEW_ROLE]);
  const panel = channel.messageMap.get(h.store.get(channel.id).panelMessageId);
  assert.ok(panel.payload.content.includes(NEW_ROLE));
  assert.ok(!panel.payload.content.includes(SPECIAL_ROLE));
  const newHandler = createInteractionHandler({ config: newConfig, service: restarted, logger: silentLogger });
  const oldStaff = interaction(h.guild, { channel, customId: IDS.resolve, userId: STAFF, roles: [SPECIAL_ROLE] });
  await newHandler(oldStaff);
  assert.match(oldStaff.response.content, /Seule l’équipe/);
  const newStaff = interaction(h.guild, { channel, customId: IDS.resolve, userId: STAFF, roles: [NEW_ROLE] });
  await newHandler(newStaff);
  assert.equal(h.store.get(channel.id).status, 'resolved');
});

test('un échec de renommage peut être réparé et ne bloque pas la suppression', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  channel.failNextRename = true;
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await waitUntil(() => Boolean(h.service.names.jobs.get(channel.id)?.timer));
  assert.equal(h.store.get(channel.id).renamePending, true);
  const repair = interaction(h.guild, { kind: 'command', channel, commandName: 'ticket-panneau', userId: STAFF, roles: [ROLE] });
  await h.handle(repair);
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🟠-pris-en-charge-/u);
  channel.failNextRename = true;
  await press(h, channel, IDS.resolve, { userId: STAFF, roles: [ROLE] });
  await waitUntil(() => Boolean(h.service.names.jobs.get(channel.id)?.timer));
  const response = await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.match(response.response.content, /suppression du salon/);
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.guild.channelMap.has(channel.id), false);
  assert.equal(h.service.names.jobs.has(channel.id), false);
});

test('un panneau manquant ou impossible à modifier ne fait pas perdre le statut', async (t) => {
  const h = harness(t);
  const { channel, ticket } = await openTicket(h);
  const panel = channel.messageMap.get(ticket.panelMessageId);
  panel.failEdit = true;
  const result = await press(h, channel, IDS.resolve, { userId: STAFF, roles: [ROLE] });
  assert.match(result.response.content, /panneau n’a pas pu être actualisé/);
  assert.equal(h.store.get(channel.id).status, 'resolved');
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🟢-traite-/u);

  channel.messageMap.delete(ticket.panelMessageId);
  channel.name = 'nom-modifie';
  const repair = interaction(h.guild, { kind: 'command', channel, commandName: 'ticket-panneau', userId: STAFF, roles: [ROLE] });
  await h.handle(repair);
  assert.match(repair.response.content, /Panneau rétabli/);
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🟢-traite-/u);
  assert.notEqual(h.store.get(channel.id).panelMessageId, ticket.panelMessageId);
  assert.ok(channel.messageMap.has(h.store.get(channel.id).panelMessageId));
});

test('une étape invalide est refusée sans changer le statut', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const modal = interaction(h.guild, { kind: 'modal', channel, customId: IDS.progressSubmit, userId: STAFF, roles: [ROLE], detail: '😇💜' });
  await h.handle(modal);
  assert.match(modal.response.content, /lettre ou un chiffre/);
  assert.equal(h.store.get(channel.id).status, 'waiting');
});

test('l’ouverture et la réouverture concurrentes respectent la limite par type', async (t) => {
  const h = harness(t);
  const old = await openTicket(h);
  await makeLegacyClosed(h, old.channel);
  const select = interaction(h.guild, { kind: 'select', customId: IDS.open, values: ['plainte'] });
  const reopen = interaction(h.guild, { channel: old.channel, customId: IDS.reopen, userId: STAFF, roles: [ROLE] });
  await Promise.all([h.handle(select), h.handle(reopen)]);
  assert.match(select.response.content, /créé/);
  assert.match(reopen.response.content, /déjà ouvert/);
  assert.equal(h.store.get(old.channel.id).status, 'closed');
  assert.notEqual(h.store.findOpen(OWNER, 'plainte').channelId, old.channel.id);
});

test('un échec du journal empêche toute suppression et préserve les droits', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const save = h.store.save.bind(h.store);
  h.store.save = (ticket) => {
    if (ticket.pendingDeletion) throw new Error('disque indisponible');
    return save(ticket);
  };
  const response = await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.match(response.response.content, /Une erreur/);
  assert.equal(h.store.get(channel.id).status, 'waiting');
  assert.equal(h.store.get(channel.id).pendingDeletion, null);
  assert.equal(h.guild.channelMap.has(channel.id), true);
  assert.match(channel.name, /^🔴-attente-/u);
  assert.equal(permission(channel, OWNER, 'SendMessages'), true);
});

test('un changement de rôles interrompu est retenté sans conserver les anciens accès', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const { channel } = await openTicket(h, 'rc_staff');
  const newConfig = loadConfig({ ...h.rawConfig, rolesStaffParCategorie: { ...h.rawConfig.rolesStaffParCategorie, rc_staff: [NEW_ROLE] } });
  const service = new TicketService({ config: newConfig, store: h.store, botUserId: BOT, logger: silentLogger });
  channel.failPermissionEdit = true;
  await assert.rejects(service.syncConfiguredRoles(h.guild), /permission refusée/);
  assert.equal(channel.permissionOverwrites.cache.has(SPECIAL_ROLE), false);
  assert.deepEqual(h.store.get(channel.id).staffRoleIds, [SPECIAL_ROLE]);
  channel.failPermissionEdit = false;
  await service.syncConfiguredRoles(h.guild);
  assert.deepEqual(h.store.get(channel.id).staffRoleIds, [NEW_ROLE]);
  assert.equal(permission(channel, NEW_ROLE, 'ViewChannel'), true);
});

test('un administrateur peut gérer un ticket même sans rôle staff', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const { channel } = await openTicket(h, 'rc_staff');
  const admin = await press(h, channel, IDS.resolve, { userId: STRANGER, permissions: [PermissionFlagsBits.Administrator] });
  assert.match(admin.response.content, /Traité/);
  assert.equal(h.store.get(channel.id).assignedTo, STRANGER);
});

test('revenir à la configuration précédente répare aussi une synchronisation interrompue', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const { channel } = await openTicket(h, 'rc_staff');
  const changed = loadConfig({ ...h.rawConfig, rolesStaffParCategorie: { ...h.rawConfig.rolesStaffParCategorie, rc_staff: [NEW_ROLE] } });
  const failed = new TicketService({ config: changed, store: h.store, botUserId: BOT, logger: silentLogger });
  channel.failPermissionEdit = true;
  await assert.rejects(failed.syncConfiguredRoles(h.guild), /permission refusée/);
  assert.deepEqual(h.store.get(channel.id).roleSyncPending, [SPECIAL_ROLE, NEW_ROLE]);
  assert.equal(channel.permissionOverwrites.cache.has(SPECIAL_ROLE), false);
  channel.failPermissionEdit = false;
  const reverted = new TicketService({ config: h.config, store: h.store, botUserId: BOT, logger: silentLogger });
  await reverted.syncConfiguredRoles(h.guild);
  assert.equal(permission(channel, SPECIAL_ROLE, 'ViewChannel'), true);
  assert.equal(channel.permissionOverwrites.cache.has(NEW_ROLE), false);
  assert.equal(h.store.get(channel.id).roleSyncPending, null);
});

test('un redémarrage restaure le nom et les permissions d’une transition interrompue', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const ticket = h.store.get(channel.id);
  const previousWrites = snapshotOwnerWrites(channel, OWNER);
  h.store.save({ ...ticket, pendingTransition: { ownerWrites: previousWrites } });
  // Simule un arrêt après la mise en lecture seule et le renommage, avant la sauvegarde finale.
  await channel.permissionOverwrites.edit(OWNER, closedOwnerWrites());
  channel.name = '⚫-ferme-plainte-elodie-0001';
  h.service.stop();
  const restartedStore = new TicketStore(h.config.dataFile, GUILD);
  const restarted = new TicketService({ config: h.config, store: restartedStore, botUserId: BOT, logger: silentLogger });
  t.after(() => restarted.stop());
  await restarted.recoverPendingTransitions(h.guild);
  await waitForName(restartedStore, channel);
  assert.equal(restartedStore.get(channel.id).status, 'waiting');
  assert.equal(restartedStore.get(channel.id).pendingTransition, null);
  assert.match(channel.name, /^🔴-attente-/u);
  assert.equal(permission(channel, OWNER, 'SendMessages'), true);
  assert.equal(permission(channel, OWNER, 'SendMessagesInThreads'), null);
});

test('si la restauration échoue, le journal reste présent pour le prochain démarrage', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const ticket = h.store.get(channel.id);
  h.store.save({ ...ticket, pendingTransition: { ownerWrites: snapshotOwnerWrites(channel, OWNER) } });
  await channel.permissionOverwrites.edit(OWNER, closedOwnerWrites());
  channel.failPermissionEdit = true;
  await assert.rejects(h.service.recoverPendingTransitions(h.guild), /permission refusée/);
  assert.ok(h.store.get(channel.id).pendingTransition);
  channel.failPermissionEdit = false;
  await h.service.recoverPendingTransitions(h.guild);
  assert.equal(h.store.get(channel.id).pendingTransition, null);
  assert.equal(permission(channel, OWNER, 'SendMessages'), true);
});

test('la limite Discord ne bloque pas le suivi et seul le dernier nom est appliqué', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  channel.rateLimitDelay = 200;
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await waitUntil(() => h.service.names.jobs.get(channel.id)?.retryReason === 'rate-limit');
  assert.match(channel.name, /^🔴-attente-/u);
  const modal = interaction(h.guild, { kind: 'modal', channel, customId: IDS.progressSubmit, userId: STAFF, roles: [ROLE], detail: 'enquête' });
  await h.handle(modal);
  await press(h, channel, IDS.resolve, { userId: STAFF, roles: [ROLE] });
  assert.equal(h.store.get(channel.id).status, 'resolved');
  assert.equal(channel.renameAttempts.length, 1);
  const panel = channel.messageMap.get(h.store.get(channel.id).panelMessageId);
  assert.match(panel.payload.embeds[0].toJSON().footer.text, /attente de synchronisation/);
  assert.match(panel.payload.embeds[0].toJSON().fields[1].value, /Traité/);

  // Une réparation manuelle ne contourne pas le délai retourné par Discord.
  const repair = interaction(h.guild, { kind: 'command', channel, commandName: 'ticket-panneau', userId: STAFF, roles: [ROLE] });
  await h.handle(repair);
  assert.equal(channel.renameAttempts.length, 1);
  channel.rateLimitDelay = 0;
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🟢-traite-/u);
  assert.equal(channel.renameAttempts.length, 2);
  assert.match(channel.renameAttempts[1], /^🟢-traite-/u);
  const close = await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.match(close.response.content, /suppression du salon/);
  assert.equal(h.store.get(channel.id).status, 'deleted');
});

test('un ancien renommage en vol est suivi du dernier statut, sans étapes intermédiaires', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  let release;
  let started;
  channel.renameGate = new Promise((resolve) => { release = resolve; });
  const inFlight = new Promise((resolve) => { started = resolve; });
  channel.onRenameStart = started;
  t.after(() => release());
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await inFlight;
  await press(h, channel, IDS.resolve, { userId: STAFF, roles: [ROLE] });
  assert.equal(h.store.get(channel.id).status, 'resolved');
  release();
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🟢-traite-/u);
  assert.equal(channel.renameAttempts.length, 2);
  assert.match(channel.renameAttempts[0], /^🟠-pris-en-charge-/u);
  assert.match(channel.renameAttempts[1], /^🟢-traite-/u);
});

test('un renommage différé est repris après redémarrage', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  channel.rateLimitDelay = 60_000;
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await waitUntil(() => h.service.names.jobs.get(channel.id)?.retryReason === 'rate-limit');
  assert.equal(h.store.get(channel.id).renamePending, true);
  h.service.stop();
  channel.rateLimitDelay = 0;
  const store = new TicketStore(h.config.dataFile, GUILD);
  const service = new TicketService({ config: h.config, store, botUserId: BOT, logger: silentLogger });
  t.after(() => service.stop());
  service.resumePendingRenames(h.guild);
  await waitForName(store, channel);
  assert.match(channel.name, /^🟠-pris-en-charge-/u);
});

test('chaque type de ticket est créé dans sa catégorie Discord configurée', async (t) => {
  const h = harness(t);
  for (const [type, categoryId] of Object.entries(CATEGORIES)) {
    const result = await openTicket(h, type);
    assert.ok(result.ticket, `Le ticket ${type} doit être créé.`);
    assert.equal(result.channel.parentId, categoryId, `Mauvaise catégorie pour ${type}.`);
  }
  assert.equal(h.guild.createCount, 6);
});

test('un ID de catégorie manquant ne crée jamais de salon à la racine', async (t) => {
  const h = harness(t);
  delete h.config.categoryIdsByType.question;
  const result = await openTicket(h, 'question');
  assert.equal(result.ticket, null);
  assert.match(result.item.response.content, /Une erreur/);
  assert.equal(h.guild.createCount, 0);
});

test('remettre en attente libère le responsable et les actions répétées sont sans effet', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const initialMessages = channel.sent.length;
  const denied = await press(h, channel, IDS.waiting, { userId: OWNER });
  assert.match(denied.response.content, /Seule l’équipe/);
  const alreadyWaiting = await press(h, channel, IDS.waiting, { userId: STAFF, roles: [ROLE] });
  assert.match(alreadyWaiting.response.content, /Aucun changement/);
  assert.equal(channel.sent.length, initialMessages);

  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await waitForName(h.store, channel);
  const claimed = h.store.get(channel.id);
  const messageCount = channel.sent.length;
  const renameCount = channel.renameAttempts.length;
  const repeat = await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  assert.match(repeat.response.content, /Aucun changement/);
  assert.equal(channel.sent.length, messageCount);
  assert.equal(channel.renameAttempts.length, renameCount);
  assert.equal(h.store.get(channel.id).updatedAt, claimed.updatedAt);

  const modal = interaction(h.guild, { kind: 'modal', channel, customId: IDS.progressSubmit, userId: STAFF, roles: [ROLE], detail: 'vérification' });
  await h.handle(modal);
  const waiting = await press(h, channel, IDS.waiting, { userId: STAFF, roles: [ROLE] });
  assert.match(waiting.response.content, /En attente/);
  assert.equal(h.store.get(channel.id).assignedTo, null);
  assert.equal(h.store.get(channel.id).progressDetail, null);
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🔴-attente-/u);
});

test('la maintenance des rôles ne modifie pas l’ancienneté du ticket', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const timestamp = '2024-01-02T12:00:00.000Z';
  h.store.save({ ...h.store.get(channel.id), updatedAt: timestamp });
  const config = loadConfig({ ...h.rawConfig, rolesStaff: [NEW_ROLE] });
  const service = new TicketService({ config, store: h.store, botUserId: BOT, logger: silentLogger });
  t.after(() => service.stop());
  await service.syncConfiguredRoles(h.guild);
  assert.equal(h.store.get(channel.id).updatedAt, timestamp);
});

test('une catégorie pleine ou la limite du serveur est signalée sans création ailleurs', async (t) => {
  const h = harness(t);
  let calls = 0;
  h.guild.channels.create = async (options) => {
    calls++;
    assert.equal(options.parent, CATEGORIES.plainte);
    throw Object.assign(new Error('Invalid Form Body'), {
      code: 50035,
      rawError: { errors: { parent_id: { _errors: [{ code: 'CHANNEL_PARENT_MAX_CHANNELS' }] } } },
    });
  };
  const fullCategory = await openTicket(h);
  assert.equal(fullCategory.ticket, null);
  assert.match(fullCategory.item.response.content, /catégorie Plainte est pleine/);
  assert.equal(calls, 1);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);

  h.guild.channels.create = async () => { throw Object.assign(new Error('limite serveur'), { code: 30013 }); };
  const fullServer = await openTicket(h);
  assert.match(fullServer.item.response.content, /limite de salons du serveur/);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);

  // D’autres erreurs 50035 ne doivent pas être présentées comme une catégorie pleine.
  h.guild.channels.create = async () => {
    throw Object.assign(new Error('erreur différente'), {
      code: 50035, rawError: { errors: { parent_id: { _errors: [{ code: 'UNKNOWN_CATEGORY' }] } } },
    });
  };
  const other = await openTicket(h);
  assert.match(other.item.response.content, /Une erreur est survenue/);
  assert.doesNotMatch(other.item.response.content, /catégorie.*pleine/);
});

test('les anciens panneaux sont mis à niveau sans nouvelles mentions, avec reprise après erreur', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const old = h.store.get(channel.id);
  assert.ok(old.panelVersion >= 2);
  delete old.panelVersion;
  h.store.save(old);
  const panel = channel.messageMap.get(old.panelMessageId);
  const messagesBefore = channel.sent.length;
  panel.failEdit = true;
  await h.service.refreshOutdatedPanels(h.guild);
  assert.equal(h.store.get(channel.id).panelVersion, undefined);
  panel.failEdit = false;
  await h.service.refreshOutdatedPanels(h.guild);
  assert.equal(h.store.get(channel.id).panelVersion, 5);
  assert.equal(channel.sent.length, messagesBefore);
  assert.deepEqual(panel.payload.allowedMentions, { parse: [] });
  const ids = panel.payload.components.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));
  assert.ok(ids.includes(IDS.manage));
  assert.ok(ids.some((id) => id.startsWith(IDS.assignmentToggle)));
  assert.ok(!ids.includes(IDS.waiting));
  const version = h.store.get(channel.id).panelVersion;
  await h.service.refreshOutdatedPanels(h.guild);
  assert.equal(h.store.get(channel.id).panelVersion, version);
  assert.equal(channel.sent.length, messagesBefore);
});

test('la mise à niveau d’un panneau et un changement de statut restent sérialisés', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const old = h.store.get(channel.id);
  delete old.panelVersion;
  h.store.save(old);
  const panel = channel.messageMap.get(old.panelMessageId);
  const edit = panel.edit;
  let release;
  let signal;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { signal = resolve; });
  panel.edit = async (payload) => { signal(); await gate; return edit(payload); };
  t.after(() => release());
  const upgrade = h.service.refreshOutdatedPanels(h.guild);
  await started;
  const claim = press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await Promise.resolve();
  assert.equal(h.store.get(channel.id).status, 'waiting');
  release();
  await Promise.all([upgrade, claim]);
  await waitForName(h.store, channel);
  assert.equal(h.store.get(channel.id).status, 'claimed');
  assert.ok(h.store.get(channel.id).panelVersion >= 2);
  assert.match(panel.payload.embeds[0].toJSON().fields[1].value, /Pris en charge/);
});

test('un salon supprimé pendant le renommage libère le registre pour une nouvelle demande', async (t) => {
  const h = harness(t);
  const old = await openTicket(h);
  let release;
  let signal;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { signal = resolve; });
  old.channel.setName = async () => { signal(); await gate; throw apiError(10003); };
  t.after(() => release());
  await press(h, old.channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await started;
  h.guild.channelMap.delete(old.channel.id);
  release();
  await waitUntil(() => h.store.get(old.channel.id).status === 'deleted');
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
  assert.equal(h.service.names.jobs.has(old.channel.id), false);
  const replacement = await openTicket(h);
  assert.ok(replacement.ticket);
  assert.notEqual(replacement.channel.id, old.channel.id);
});

test('une erreur de stockage à la création supprime le salon sans laisser de doublon', async (t) => {
  const h = harness(t);
  const save = h.store.save.bind(h.store);
  h.store.save = (record) => {
    if (!h.store.get(record.channelId)) throw new Error('disque plein');
    return save(record);
  };
  const attempt = await openTicket(h);
  assert.equal(attempt.ticket, null);
  assert.match(attempt.item.response.content, /Une erreur est survenue/);
  assert.equal(h.guild.createCount, 1);
  assert.equal(h.guild.channelMap.size, 0);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
  h.store.save = save;
  const retry = await openTicket(h);
  assert.ok(retry.ticket);
  assert.equal(h.guild.channelMap.size, 1);
});

test('un échec du panneau initial n’efface pas le ticket et peut être réparé', async (t) => {
  const h = harness(t);
  const create = h.guild.channels.create;
  h.guild.channels.create = async (options) => {
    const channel = await create(options);
    channel.failSend = true;
    return channel;
  };
  const created = await openTicket(h);
  assert.ok(created.ticket);
  assert.match(created.item.response.content, /panneau n’a pas pu être envoyé/);
  assert.equal(created.ticket.panelMessageId, null);
  assert.equal(created.ticket.panelVersion, null);
  created.channel.failSend = false;
  const repair = interaction(h.guild, { kind: 'command', channel: created.channel, commandName: 'ticket-panneau', userId: STAFF, roles: [ROLE] });
  await h.handle(repair);
  assert.match(repair.response.content, /Panneau rétabli/);
  assert.ok(h.store.get(created.channel.id).panelMessageId);
  assert.ok(h.store.get(created.channel.id).panelVersion >= 2);
  await waitForName(h.store, created.channel);
});

test('/ticket-fermer et les boutons protègent la suppression ; l’annulation ne change rien', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const outsider = await press(h, channel, IDS.close, { userId: STRANGER });
  assert.match(outsider.response.content, /créateur.*équipe/);
  const forged = await press(h, channel, IDS.closeDeleteConfirm, { userId: STRANGER });
  assert.match(forged.response.content, /créateur.*équipe/);
  assert.equal(h.guild.channelMap.has(channel.id), true);
  const command = interaction(h.guild, { kind: 'command', channel, commandName: 'ticket-fermer', userId: OWNER });
  await h.handle(command);
  assert.match(command.response.content, /définitivement.*tous ses messages/);
  assert.equal(command.response.components[0].toJSON().components[0].custom_id, IDS.closeDeleteConfirm);
  const cancel = await press(h, channel, IDS.cancel, { userId: OWNER });
  assert.match(cancel.response.content, /annulée/);
  assert.equal(h.store.get(channel.id).status, 'waiting');
  const staffCommand = interaction(h.guild, { kind: 'command', channel, commandName: 'ticket-fermer', userId: STAFF, roles: [ROLE] });
  await h.handle(staffCommand);
  assert.match(staffCommand.response.content, /Aucune transcription/);
  await press(h, channel, IDS.closeDeleteConfirm, { userId: STAFF, roles: [ROLE] });
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.store.get(channel.id).closedBy, STAFF);
});

test('un refus de suppression laisse le ticket ouvert et reprend les renommages en attente', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  channel.rateLimitDelay = 60_000;
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await waitUntil(() => h.service.names.jobs.get(channel.id)?.retryReason === 'rate-limit');
  const deferredRename = h.service.names.jobs.get(channel.id);
  channel.failDelete = true;
  const failed = await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.match(failed.response.content, /n’a pas été supprimé.*permissions/);
  assert.equal(h.store.get(channel.id).status, 'claimed');
  assert.equal(h.store.get(channel.id).pendingDeletion, null);
  assert.equal(h.guild.channelMap.has(channel.id), true);
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, channel.id);
  assert.equal(permission(channel, OWNER, 'SendMessages'), true);
  assert.equal(h.service.names.jobs.get(channel.id), deferredRename, 'Le délai Discord est conservé après l’échec.');
  channel.failDelete = false;
  await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.service.names.jobs.has(channel.id), false);
});

test('une suppression réussie malgré une erreur réseau est confirmée par la disparition du salon', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const deleteChannel = channel.delete.bind(channel);
  channel.delete = async () => { await deleteChannel(); throw new Error('réponse Discord perdue'); };
  await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.equal(h.guild.channelMap.has(channel.id), false);
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.store.get(channel.id).closedBy, OWNER);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
});

test('une suppression incertaine conserve le journal et ne se relance jamais automatiquement', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  channel.failDelete = true;
  const fetch = h.guild.channels.fetch;
  let requests = 0;
  h.guild.channels.fetch = async (...args) => {
    if (++requests > 1) throw new Error('Discord indisponible');
    return fetch(...args);
  };
  const failed = await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.match(failed.response.content, /Impossible de vérifier la suppression/);
  assert.equal(h.store.get(channel.id).pendingDeletion.actorId, OWNER);
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, channel.id);
  h.service.stop();
  h.guild.channels.fetch = fetch;
  let attempted = false;
  channel.delete = async () => { attempted = true; throw new Error('ne doit pas être appelé'); };
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = new TicketService({ config: h.config, store: reloaded, botUserId: BOT, logger: silentLogger });
  t.after(() => service.stop());
  await service.recoverPendingDeletions(h.guild);
  assert.equal(attempted, false);
  assert.equal(reloaded.get(channel.id).pendingDeletion, null);
  assert.equal(reloaded.get(channel.id).status, 'waiting');
  assert.equal(h.guild.channelMap.has(channel.id), true);
});

test('la reprise finalise un salon disparu mais préserve les salons existants et leurs anciens tickets fermés', async (t) => {
  const h = harness(t);
  const removed = await openTicket(h);
  const existing = await openTicket(h, 'question');
  const legacy = await openTicket(h, 'fondation');
  await makeLegacyClosed(h, legacy.channel);
  const requestedAt = '2026-01-01T00:00:00.000Z';
  for (const channel of [removed.channel, existing.channel]) {
    h.store.save({ ...h.store.get(channel.id), pendingDeletion: { actorId: OWNER, requestedAt } });
  }
  h.service.stop();
  h.guild.channelMap.delete(removed.channel.id);
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = new TicketService({ config: h.config, store: reloaded, botUserId: BOT, logger: silentLogger });
  t.after(() => service.stop());
  await service.recoverPendingDeletions(h.guild);
  assert.equal(reloaded.get(removed.channel.id).status, 'deleted');
  assert.equal(reloaded.get(removed.channel.id).closedBy, OWNER);
  assert.equal(reloaded.get(removed.channel.id).closedAt, requestedAt);
  assert.equal(reloaded.get(removed.channel.id).pendingDeletion, null);
  assert.equal(reloaded.findOpen(OWNER, 'plainte'), null);
  assert.equal(reloaded.get(existing.channel.id).status, 'waiting');
  assert.equal(reloaded.get(existing.channel.id).pendingDeletion, null);
  assert.equal(h.guild.channelMap.has(existing.channel.id), true);
  assert.equal(reloaded.get(legacy.channel.id).status, 'closed');
  assert.equal(h.guild.channelMap.has(legacy.channel.id), true);
});

test('après suppression, une erreur disque est réparée au redémarrage grâce au journal', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const save = h.store.save.bind(h.store);
  h.store.save = (ticket) => {
    if (ticket.status === 'deleted') throw new Error('disque indisponible après suppression');
    return save(ticket);
  };
  const response = await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.match(response.response.content, /Une erreur/);
  assert.equal(h.guild.channelMap.has(channel.id), false);
  assert.equal(h.store.get(channel.id).pendingDeletion.actorId, OWNER);
  assert.ok(h.store.findOpen(OWNER, 'plainte'));
  h.service.stop();
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = new TicketService({ config: h.config, store: reloaded, botUserId: BOT, logger: silentLogger });
  t.after(() => service.stop());
  await service.recoverPendingDeletions(h.guild);
  assert.equal(reloaded.get(channel.id).status, 'deleted');
  assert.equal(reloaded.get(channel.id).closedBy, OWNER);
  assert.equal(reloaded.findOpen(OWNER, 'plainte'), null);
});

test('la fermeture, ChannelDelete et une nouvelle ouverture sont sérialisés par propriétaire et type', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  let release;
  let started;
  let deletionEvent;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const deleteChannel = channel.delete.bind(channel);
  channel.delete = async () => {
    started();
    await gate;
    const result = await deleteChannel();
    deletionEvent = h.service.channelDeleted(channel);
    return result;
  };
  const closing = press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  await running;
  const opening = openTicket(h);
  await Promise.resolve();
  assert.equal(h.guild.createCount, 1);
  assert.equal(h.store.get(channel.id).pendingDeletion.actorId, OWNER);
  release();
  const [, replacement] = await Promise.all([closing, opening]);
  await deletionEvent;
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.store.get(channel.id).closedBy, OWNER);
  assert.notEqual(replacement.channel.id, channel.id);
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, replacement.channel.id);
  assert.equal(h.guild.createCount, 2);
});

test('une suppression annule un renommage déjà en vol sans ressusciter le ticket', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  let release;
  let started;
  channel.renameGate = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  channel.onRenameStart = started;
  t.after(() => release());
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await running;
  await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.equal(h.store.get(channel.id).status, 'deleted');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.store.get(channel.id).renamePending, false);
  assert.equal(h.service.names.jobs.has(channel.id), false);
  assert.equal(h.guild.channelMap.has(channel.id), false);
});

test('la reprise d’un ticket déjà attribué est explicite, personnelle et vérifiée sous verrou', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  const request = interaction(h.guild, { kind: 'command', channel, commandName: 'ticket-prendre', userId: STRANGER, roles: [ROLE] });
  await h.handle(request);
  assert.match(request.response.content, new RegExp(`déjà attribué à <@${STAFF}>`));
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  const takeoverId = request.response.components[0].toJSON().components[0].custom_id;
  assert.ok(takeoverId.length <= 100);
  const wrongUser = await press(h, channel, takeoverId, { userId: OWNER, roles: [ROLE] });
  assert.match(wrongUser.response.content, /ne vous appartient pas/);
  const revoked = await press(h, channel, takeoverId, { userId: STRANGER });
  assert.match(revoked.response.content, /Seule l’équipe/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  const accepted = await press(h, channel, takeoverId, { userId: STRANGER, roles: [ROLE], permissions: [PermissionFlagsBits.ViewChannel] });
  assert.match(accepted.response.content, /Pris en charge/);
  assert.equal(h.store.get(channel.id).assignedTo, STRANGER);

  const staleRequest = await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  const staleId = staleRequest.response.components[0].toJSON().components[0].custom_id;
  await press(h, channel, IDS.waiting, { userId: STRANGER, roles: [ROLE] });
  const stale = await press(h, channel, staleId, { userId: STAFF, roles: [ROLE], permissions: [PermissionFlagsBits.ViewChannel] });
  assert.match(stale.response.content, /responsable a changé/);
  assert.equal(h.store.get(channel.id).assignedTo, null);
  assert.equal(h.store.get(channel.id).status, 'waiting');
});

test('deux prises en charge simultanées ne réattribuent pas silencieusement le ticket', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const first = interaction(h.guild, { channel, customId: IDS.claim, userId: STAFF, roles: [ROLE] });
  const second = interaction(h.guild, { channel, customId: IDS.claim, userId: STRANGER, roles: [ROLE] });
  await Promise.all([h.handle(first), h.handle(second)]);
  const responses = [first.response, second.response];
  assert.equal(responses.filter((response) => /déjà attribué/.test(response.content)).length, 1);
  assert.equal(responses.filter((response) => /Pris en charge/.test(response.content)).length, 1);
  assert.ok([STAFF, STRANGER].includes(h.store.get(channel.id).assignedTo));
});

test('la priorité staff est persistante, idempotente et ne modifie pas l’ancienneté', async (t) => {
  const h = harness(t);
  const { channel, ticket } = await openTicket(h);
  const initialAge = h.store.get(channel.id).updatedAt;
  const denied = await press(h, channel, IDS.urgent, { userId: OWNER });
  assert.match(denied.response.content, /Seule l’équipe/);
  const changed = await press(h, channel, IDS.urgent, { userId: STAFF, roles: [ROLE] });
  assert.match(changed.response.content, /Priorité mise à jour.*Urgente/);
  assert.equal(h.store.get(channel.id).urgent, true);
  assert.equal(h.store.get(channel.id).updatedAt, initialAge);
  const panel = channel.messageMap.get(ticket.panelMessageId).payload;
  assert.match(panel.embeds[0].toJSON().fields[3].value, /Urgente/);
  assert.ok(panel.components.flatMap((row) => row.toJSON().components).some((button) => button.custom_id === IDS.manage));
  const before = channel.sent.length;
  const repeated = await press(h, channel, IDS.urgent, { userId: STAFF, roles: [ROLE] });
  assert.match(repeated.response.content, /Priorité inchangée/);
  assert.equal(channel.sent.length, before);
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  assert.equal(reloaded.get(channel.id).urgent, true);
  const normal = await press(h, channel, IDS.normal, { userId: STAFF, roles: [ROLE] });
  assert.match(normal.response.content, /Priorité mise à jour.*Normale/);
  assert.equal(h.store.get(channel.id).urgent, false);
  assert.equal(h.store.get(channel.id).updatedAt, initialAge);
  assert.deepEqual(channel.sent.at(-1).payload.allowedMentions, { parse: [] });
});

test('une ancienne confirmation de reprise est refusée même si le même responsable revient', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  const requested = await press(h, channel, IDS.claim, { userId: STRANGER, roles: [ROLE] });
  const staleId = requested.response.components[0].toJSON().components[0].custom_id;
  const initialRevision = h.store.get(channel.id).assignmentRevision;
  await press(h, channel, IDS.waiting, { userId: STAFF, roles: [ROLE] });
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  assert.ok(h.store.get(channel.id).assignmentRevision > initialRevision);
  const stale = await press(h, channel, staleId, { userId: STRANGER, roles: [ROLE], permissions: [PermissionFlagsBits.ViewChannel] });
  assert.match(stale.response.content, /responsable a changé/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
});

test('un redémarrage ne peut pas effacer le journal si Discord est injoignable', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const requestedAt = new Date().toISOString();
  h.store.save({ ...h.store.get(channel.id), pendingDeletion: { actorId: OWNER, requestedAt } });
  h.guild.channels.fetch = async () => { throw new Error('réseau indisponible'); };
  await assert.rejects(h.service.recoverPendingDeletions(h.guild), /réseau indisponible/);
  assert.deepEqual(h.store.get(channel.id).pendingDeletion, { actorId: OWNER, requestedAt });
  assert.equal(h.store.get(channel.id).status, 'waiting');
  assert.equal(h.guild.channelMap.has(channel.id), true);
});

test('un ancien ticket fermé supprimé juste avant une interruption est réconcilié sans affecter un nouveau ticket', async (t) => {
  const h = harness(t);
  const old = await openTicket(h);
  const legacy = await makeLegacyClosed(h, old.channel);
  const newer = await openTicket(h);
  const requestedAt = new Date().toISOString();
  h.store.save({ ...legacy, pendingDeletion: { actorId: STAFF, requestedAt } });
  h.service.stop();
  h.guild.channelMap.delete(old.channel.id);
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = new TicketService({ config: h.config, store: reloaded, botUserId: BOT, logger: silentLogger });
  t.after(() => service.stop());
  await service.recoverPendingDeletions(h.guild);
  assert.equal(reloaded.get(old.channel.id).status, 'deleted');
  assert.equal(reloaded.get(old.channel.id).closedAt, legacy.closedAt);
  assert.equal(reloaded.get(old.channel.id).closedBy, null, 'Le responsable historique de la fermeture n’était pas connu.');
  assert.equal(reloaded.get(old.channel.id).deletedBy, STAFF);
  assert.equal(reloaded.get(old.channel.id).deletionRequestedAt, requestedAt);
  assert.equal(reloaded.findOpen(OWNER, 'plainte').channelId, newer.channel.id);
});

test('une ancienne attribution sans numéro de révision peut être reprise après confirmation', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  const old = h.store.get(channel.id);
  delete old.assignmentRevision;
  delete old.urgent;
  h.store.save(old);
  const requested = await press(h, channel, IDS.claim, { userId: STRANGER, roles: [ROLE] });
  const takeoverId = requested.response.components[0].toJSON().components[0].custom_id;
  assert.ok(takeoverId.endsWith(':0'));
  await press(h, channel, takeoverId, { userId: STRANGER, roles: [ROLE], permissions: [PermissionFlagsBits.ViewChannel] });
  assert.equal(h.store.get(channel.id).assignedTo, STRANGER);
  assert.equal(h.store.get(channel.id).assignmentRevision, 1);
});

test('deux confirmations simultanées ne demandent qu’une suppression Discord', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  let calls = 0;
  const deleteChannel = channel.delete.bind(channel);
  channel.delete = async () => { calls++; return deleteChannel(); };
  const first = interaction(h.guild, { channel, customId: IDS.closeDeleteConfirm, userId: OWNER });
  const second = interaction(h.guild, { channel, customId: IDS.closeDeleteConfirm, userId: STAFF, roles: [ROLE] });
  await Promise.all([h.handle(first), h.handle(second)]);
  assert.equal(calls, 1);
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.guild.channelMap.has(channel.id), false);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
});

test('un refus de suppression ne lance pas un deuxième renommage pendant un PATCH déjà en vol', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  let release;
  let started;
  channel.renameGate = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  channel.onRenameStart = started;
  t.after(() => release());
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await running;
  channel.failDelete = true;
  const failed = await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.match(failed.response.content, /n’a pas été supprimé/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.renameAttempts.length, 1, 'Le premier PATCH doit terminer avant toute nouvelle tentative.');
  await press(h, channel, IDS.resolve, { userId: STAFF, roles: [ROLE] });
  assert.equal(channel.renameAttempts.length, 1);
  release();
  await waitForName(h.store, channel);
  assert.equal(channel.renameAttempts.length, 2);
  assert.match(channel.name, /^🟢-traite-/u);
  assert.equal(h.store.get(channel.id).status, 'resolved');
});

test('la suppression confirmée ne dépend pas de restaurer une ancienne transition de permissions', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  h.store.save({ ...h.store.get(channel.id), pendingTransition: { ownerWrites: snapshotOwnerWrites(channel, OWNER) } });
  channel.failPermissionEdit = true;
  channel.failDelete = true;
  const failed = await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.match(failed.response.content, /n’a pas été supprimé/);
  assert.ok(h.store.get(channel.id).pendingTransition, 'Un échec de suppression doit conserver l’ancien journal.');
  assert.equal(h.store.get(channel.id).pendingDeletion, null);
  channel.failDelete = false;
  await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.store.get(channel.id).pendingTransition, null);
  assert.equal(h.guild.channelMap.has(channel.id), false);
});

test('Gérer le dossier rassemble les actions et reste réservé au staff qui voit le salon', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const owner = await press(h, channel, IDS.manage, { userId: OWNER, permissions: [PermissionFlagsBits.ViewChannel] });
  assert.match(owner.response.content, /Seule l’équipe/);
  const hiddenStaff = await press(h, channel, IDS.manage, { userId: STAFF, roles: [ROLE] });
  assert.match(hiddenStaff.response.content, /voir ce salon/);
  const staff = await press(h, channel, IDS.manage, staffAccess);
  assert.equal(staff.response.flags, MessageFlags.Ephemeral);
  const menu = staff.response.components[0].toJSON().components[0];
  assert.equal(menu.custom_id, `${IDS.manageMenu}${STAFF}`);
  assert.deepEqual(menu.options.map((option) => option.value), ['claim', 'progress', 'resolve', 'waiting', 'priority', 'category', 'note-add', 'note-list', 'role']);
  const stranger = await choose(h, channel, menu.custom_id, 'note-list', { userId: STRANGER, roles: [ROLE] });
  assert.match(stranger.response.content, /personnel/);
  assert.ok(!stranger.response.embeds?.length);
});

test('les anciens boutons de suivi sont remplacés par des actions fonctionnelles dans le menu staff', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const claim = await manageAction(h, channel, 'claim');
  assert.match(claim.response.content, /Pris en charge/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  const step = await manageAction(h, channel, 'progress');
  assert.match(step.modal.custom_id, new RegExp(`^${IDS.manageProgressSubmit}${STAFF}:plainte:0$`));
  const modal = interaction(h.guild, { kind: 'modal', channel, customId: step.modal.custom_id, detail: 'Analyse du dossier', ...staffAccess });
  await h.handle(modal);
  assert.equal(h.store.get(channel.id).status, 'progress');
  assert.equal(h.store.get(channel.id).progressDetail, 'Analyse du dossier');
  const resolved = await manageAction(h, channel, 'resolve');
  assert.match(resolved.response.content, /Traité/);
  const waiting = await manageAction(h, channel, 'waiting');
  assert.match(waiting.response.content, /En attente/);
  assert.equal(h.store.get(channel.id).assignedTo, null);
});

test('la priorité se modifie depuis le dossier sans changer l’ancienneté ni créer de commandes', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const age = h.store.get(channel.id).updatedAt;
  const submenu = await manageAction(h, channel, 'priority');
  assert.equal(submenu.response.components[0].toJSON().components[0].custom_id, `${IDS.managePriority}${STAFF}`);
  const urgent = await choose(h, channel, `${IDS.managePriority}${STAFF}`, 'urgent');
  assert.match(urgent.response.content, /Priorité mise à jour.*urgente/);
  assert.equal(h.store.get(channel.id).urgent, true);
  assert.equal(h.store.get(channel.id).updatedAt, age);
  const normal = await choose(h, channel, `${IDS.managePriority}${STAFF}`, 'normal');
  assert.match(normal.response.content, /Priorité mise à jour.*normale/);
  assert.equal(h.store.get(channel.id).urgent, false);
  assert.equal(h.store.get(channel.id).updatedAt, age);
});

test('les notes internes restent privées, paginées et effacées lors de la suppression', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const countBefore = channel.sent.length;
  const age = h.store.get(channel.id).updatedAt;
  const noteButton = await manageAction(h, channel, 'note-add');
  assert.equal(noteButton.modal.custom_id, `${IDS.manageNoteSubmit}${STAFF}:plainte:0`);
  for (const detail of ['Enquête privée A', 'Enquête privée B', 'Enquête privée C']) {
    const submitted = interaction(h.guild, { kind: 'modal', channel, customId: noteButton.modal.custom_id, detail, ...staffAccess });
    await h.handle(submitted);
    assert.match(submitted.response.content, /Note interne enregistrée/);
    assert.equal(submitted.deferOptions.flags, MessageFlags.Ephemeral);
  }
  assert.equal(channel.sent.length, countBefore, 'Aucune note ne doit être envoyée dans le salon visible par le membre.');
  assert.ok(!JSON.stringify(channel.sent).includes('Enquête privée'));
  assert.equal(h.store.get(channel.id).updatedAt, age);
  assert.equal(new TicketStore(h.config.dataFile, GUILD).get(channel.id).internalNotes.length, 3);
  const first = await manageAction(h, channel, 'note-list');
  const embed = first.response.embeds[0].toJSON();
  assert.match(embed.description, /Enquête privée C/);
  assert.match(embed.description, /Enquête privée B/);
  assert.doesNotMatch(embed.description, /Enquête privée A/);
  assert.match(embed.footer.text, /Page 1\/2/);
  const nextId = first.response.components[0].toJSON().components[1].custom_id;
  const next = await press(h, channel, nextId, staffAccess);
  assert.match(next.response.embeds[0].toJSON().description, /Enquête privée A/);
  const owner = await choose(h, channel, `${IDS.manageMenu}${OWNER}`, 'note-list', { userId: OWNER, roles: [] });
  assert.match(owner.response.content, /Seule l’équipe/);
  assert.ok(!JSON.stringify(owner.response).includes('Enquête privée'));
  const forged = interaction(h.guild, { kind: 'modal', channel, customId: noteButton.modal.custom_id, detail: 'intrus', userId: STRANGER, roles: [ROLE], permissions: [PermissionFlagsBits.ViewChannel] });
  await h.handle(forged);
  assert.match(forged.response.content, /personnel/);
  assert.equal(h.store.get(channel.id).internalNotes.length, 3);
  await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.deepEqual(h.store.get(channel.id).internalNotes, []);
  assert.ok(!fs.readFileSync(h.config.dataFile, 'utf8').includes('Enquête privée'));
});

test('le message au rôle est public, n’ouvre pas le salon et ne notifie que le rôle choisi', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const submenu = await manageAction(h, channel, 'role');
  assert.match(submenu.response.content, /publié dans ce ticket.*visible par son créateur/);
  assert.match(submenu.response.content, /ne lui donne pas accès/);
  const selector = interaction(h.guild, { kind: 'role-select', channel, customId: `${IDS.manageRoleSelect}${STAFF}`, values: [NEW_ROLE], ...staffAccess });
  await h.handle(selector);
  assert.equal(selector.modal.custom_id, `${IDS.manageRoleSubmit}${STAFF}:plainte:0:${NEW_ROLE}`);
  const modal = interaction(h.guild, { kind: 'modal', channel, customId: selector.modal.custom_id, detail: `Besoin d’aide @everyone <@${OWNER}> <@&${SPECIAL_ROLE}>`, ...staffAccess });
  const before = channel.sent.length;
  await h.handle(modal);
  assert.match(modal.response.content, /Message publié/);
  assert.equal(channel.sent.length, before + 1);
  const message = channel.sent.at(-1).payload;
  assert.match(message.content, new RegExp(`<@&${NEW_ROLE}>`));
  assert.match(message.content, /Besoin d’aide/);
  assert.deepEqual(message.allowedMentions, { parse: [], roles: [NEW_ROLE] });
  assert.equal(channel.permissionOverwrites.cache.has(NEW_ROLE), false);
  assert.deepEqual(h.store.get(channel.id).internalNotes, []);
  const everyone = interaction(h.guild, { kind: 'role-select', channel, customId: `${IDS.manageRoleSelect}${STAFF}`, values: [GUILD], ...staffAccess });
  await h.handle(everyone);
  assert.match(everyone.response.content, /autre que @everyone/);
});

test('un rôle non mentionnable est refusé sauf si le bot peut mentionner les rôles', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  h.guild.roleMap.get(NEW_ROLE).mentionable = false;
  const id = `${IDS.manageRoleSubmit}${STAFF}:plainte:0:${NEW_ROLE}`;
  const denied = interaction(h.guild, { kind: 'modal', channel, customId: id, detail: 'Pouvez-vous aider ?', ...staffAccess });
  const count = channel.sent.length;
  await h.handle(denied);
  assert.match(denied.response.content, /rôle n’est pas mentionnable/);
  assert.equal(channel.sent.length, count);
  channel.botPermissions = [PermissionFlagsBits.MentionEveryone];
  const allowed = interaction(h.guild, { kind: 'modal', channel, customId: id, detail: 'Pouvez-vous aider ?', ...staffAccess });
  await h.handle(allowed);
  assert.match(allowed.response.content, /Message publié/);
  assert.equal(channel.sent.length, count + 1);
  const absent = interaction(h.guild, { kind: 'modal', channel, customId: `${IDS.manageRoleSubmit}${STAFF}:plainte:0:200000000000000099`, detail: 'test', ...staffAccess });
  await h.handle(absent);
  assert.match(absent.response.content, /rôle est introuvable/);
});

test('changer le type déplace le salon, applique les nouveaux rôles et remet le dossier en attente', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const { channel } = await openTicket(h);
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await press(h, channel, IDS.urgent, { userId: STAFF, roles: [ROLE] });
  await waitForName(h.store, channel);
  await channel.permissionOverwrites.edit(NEW_ROLE, { ViewChannel: true }); // accès manuel distinct
  channel.permissionEvents.length = 0;
  const submenu = await manageAction(h, channel, 'category');
  assert.equal(submenu.response.components[0].toJSON().components[0].custom_id, `${IDS.manageCategory}${STAFF}`);
  const selected = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'rc_staff');
  assert.match(selected.response.content, /responsable libéré.*remis en attente/);
  assert.match(selected.response.content, /accès ajoutés manuellement restent/);
  const confirmId = selected.response.components[0].toJSON().components[0].custom_id;
  const done = await press(h, channel, confirmId, staffAccess);
  assert.match(done.response.content, /Catégorie changée : RC STAFF/);
  assert.match(done.response.content, /gestion est désormais réservée/);
  const ticket = h.store.get(channel.id);
  assert.equal(ticket.type, 'rc_staff');
  assert.equal(ticket.categoryRevision, 1);
  assert.equal(ticket.status, 'waiting');
  assert.equal(ticket.assignedTo, null);
  assert.equal(ticket.urgent, true);
  assert.equal(channel.parentId, CATEGORIES.rc_staff);
  assert.equal(channel.channelEditOptions.lockPermissions, false);
  assert.match(channel.topic, /RC STAFF/);
  assert.equal(channel.permissionOverwrites.cache.has(ROLE), false);
  assert.equal(permission(channel, SPECIAL_ROLE, 'ViewChannel'), true);
  assert.equal(permission(channel, NEW_ROLE, 'ViewChannel'), true);
  assert.ok(channel.permissionEvents.indexOf(`delete:${ROLE}`) < channel.permissionEvents.indexOf(`edit:${SPECIAL_ROLE}`));
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
  assert.equal(h.store.findOpen(OWNER, 'rc_staff').channelId, channel.id);
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🔴-attente-rc-staff-/u);
  const oldStaff = await press(h, channel, IDS.manage, staffAccess);
  assert.match(oldStaff.response.content, /Seule l’équipe/);
  const newStaff = await press(h, channel, IDS.manage, { userId: STAFF, roles: [SPECIAL_ROLE], permissions: [PermissionFlagsBits.ViewChannel] });
  assert.equal(newStaff.response.flags, MessageFlags.Ephemeral);
  const replacement = await openTicket(h, 'plainte');
  assert.ok(replacement.ticket);
  assert.notEqual(replacement.channel.id, channel.id);
});

test('une catégorie déjà occupée ou non autorisée ne modifie ni salon ni droits', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const source = await openTicket(h);
  const destination = await openTicket(h, 'rc_staff');
  const selected = await choose(h, source.channel, `${IDS.manageCategory}${STAFF}`, 'rc_staff');
  const confirmId = selected.response.components[0].toJSON().components[0].custom_id;
  const denied = await press(h, source.channel, confirmId, { userId: OWNER, permissions: [PermissionFlagsBits.ViewChannel] });
  assert.match(denied.response.content, /personnel/);
  const duplicate = await press(h, source.channel, confirmId, staffAccess);
  assert.match(duplicate.response.content, /déjà un ticket ouvert/);
  assert.equal(h.store.get(source.channel.id).type, 'plainte');
  assert.equal(h.store.get(source.channel.id).pendingReclassification, null);
  assert.equal(source.channel.parentId, CATEGORIES.plainte);
  assert.equal(permission(source.channel, ROLE, 'ViewChannel'), true);
  assert.equal(source.channel.permissionOverwrites.cache.has(SPECIAL_ROLE), false);
  assert.equal(h.store.findOpen(OWNER, 'rc_staff').channelId, destination.channel.id);
});

test('un formulaire de note et une confirmation de catégorie périmés ne s’appliquent pas au nouveau dossier', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const note = await manageAction(h, channel, 'note-add');
  const selection = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'question');
  const staleConfirm = selection.response.components[0].toJSON().components[0].custom_id;
  await press(h, channel, staleConfirm, staffAccess);
  assert.equal(h.store.get(channel.id).type, 'question');
  const oldNote = interaction(h.guild, { kind: 'modal', channel, customId: note.modal.custom_id, detail: 'Ne pas enregistrer', ...staffAccess });
  await h.handle(oldNote);
  assert.match(oldNote.response.content, /catégorie du ticket a changé/);
  assert.deepEqual(h.store.get(channel.id).internalNotes, []);
  const back = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'plainte');
  await press(h, channel, back.response.components[0].toJSON().components[0].custom_id, staffAccess);
  assert.equal(h.store.get(channel.id).type, 'plainte');
  assert.equal(h.store.get(channel.id).categoryRevision, 2);
  const stale = await press(h, channel, staleConfirm, staffAccess);
  assert.match(stale.response.content, /catégorie du ticket a changé/);
  assert.equal(h.store.get(channel.id).type, 'plainte');
});

test('un déplacement et l’ouverture simultanée du nouveau type ne créent pas de doublon', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const selected = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'question');
  const confirmId = selected.response.components[0].toJSON().components[0].custom_id;
  let release;
  let started;
  channel.editGate = new Promise((resolve) => { release = resolve; });
  const moving = new Promise((resolve) => { started = resolve; });
  channel.onEditStart = started;
  t.after(() => release());
  const change = press(h, channel, confirmId, staffAccess);
  await moving;
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, channel.id);
  assert.equal(h.store.findOpen(OWNER, 'question').channelId, channel.id);
  const open = openTicket(h, 'question');
  await Promise.resolve();
  assert.equal(h.guild.createCount, 1);
  release();
  const [, result] = await Promise.all([change, open]);
  assert.match(result.item.response.content, /déjà un ticket ouvert/);
  assert.equal(result.ticket.channelId, channel.id);
  assert.equal(h.guild.createCount, 1);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
  assert.equal(h.store.findOpen(OWNER, 'question').channelId, channel.id);
});

test('une reclassification interrompue réserve les deux types et reprend avec les rôles configurés au redémarrage', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Note privée conservée');
  channel.failChannelEdit = new Error('déplacement indisponible');
  const selected = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'rc_staff');
  const failed = await press(h, channel, selected.response.components[0].toJSON().components[0].custom_id, staffAccess);
  assert.match(failed.response.content, /interrompu.*accès ont pu changer/);
  assert.equal(h.store.get(channel.id).type, 'plainte');
  assert.equal(h.store.get(channel.id).pendingReclassification.targetType, 'rc_staff');
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, channel.id);
  assert.equal(h.store.findOpen(OWNER, 'rc_staff').channelId, channel.id);
  assert.equal(channel.permissionOverwrites.cache.has(ROLE), false);
  assert.equal(permission(channel, SPECIAL_ROLE, 'ViewChannel'), true);
  const blocked = await openTicket(h, 'rc_staff');
  assert.match(blocked.item.response.content, /changement de catégorie.*en cours/);
  assert.equal(h.guild.createCount, 1);
  h.service.stop();
  channel.failChannelEdit = null;
  const config = loadConfig({ ...h.rawConfig, rolesStaffParCategorie: { rc_staff: [NEW_ROLE] } }, path.dirname(path.dirname(h.config.dataFile)));
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = new TicketService({ config, store: reloaded, botUserId: BOT, logger: silentLogger });
  t.after(() => service.stop());
  await service.recoverPendingReclassifications(h.guild);
  const ticket = reloaded.get(channel.id);
  assert.equal(ticket.type, 'rc_staff');
  assert.equal(ticket.pendingReclassification, null);
  assert.equal(ticket.internalNotes[0].text, 'Note privée conservée');
  assert.equal(channel.parentId, CATEGORIES.rc_staff);
  assert.equal(channel.permissionOverwrites.cache.has(SPECIAL_ROLE), false);
  assert.equal(permission(channel, NEW_ROLE, 'ViewChannel'), true);
  assert.equal(reloaded.findOpen(OWNER, 'plainte'), null);
  assert.equal(reloaded.findOpen(OWNER, 'rc_staff').channelId, channel.id);
  assert.ok(!JSON.stringify(channel.sent).includes('Note privée conservée'));
});

test('une erreur disque après déplacement est réparée au redémarrage sans perdre les réservations', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const { channel } = await openTicket(h);
  const save = h.store.save.bind(h.store);
  h.store.save = (ticket) => {
    if (ticket.type === 'rc_staff' && !ticket.pendingReclassification) throw new Error('disque indisponible');
    return save(ticket);
  };
  const selected = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'rc_staff');
  const failed = await press(h, channel, selected.response.components[0].toJSON().components[0].custom_id, staffAccess);
  assert.match(failed.response.content, /interrompu/);
  assert.equal(channel.parentId, CATEGORIES.rc_staff);
  assert.equal(h.store.get(channel.id).type, 'plainte');
  assert.ok(h.store.get(channel.id).pendingReclassification);
  assert.equal(h.store.findOpen(OWNER, 'rc_staff').channelId, channel.id);
  h.service.stop();
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = new TicketService({ config: h.config, store: reloaded, botUserId: BOT, logger: silentLogger });
  t.after(() => service.stop());
  await service.recoverPendingReclassifications(h.guild);
  assert.equal(reloaded.get(channel.id).type, 'rc_staff');
  assert.equal(reloaded.get(channel.id).pendingReclassification, null);
  assert.equal(reloaded.findOpen(OWNER, 'plainte'), null);
  assert.equal(reloaded.findOpen(OWNER, 'rc_staff').channelId, channel.id);
});

test('le créateur peut fermer un ticket dont la reclassification a échoué, en libérant les deux emplacements', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Note à effacer');
  channel.failChannelEdit = new Error('déplacement impossible');
  const selected = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'question');
  await press(h, channel, selected.response.components[0].toJSON().components[0].custom_id, staffAccess);
  assert.ok(h.store.get(channel.id).pendingReclassification);
  await press(h, channel, IDS.closeDeleteConfirm, { userId: OWNER });
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.equal(h.store.get(channel.id).pendingReclassification, null);
  assert.deepEqual(h.store.get(channel.id).internalNotes, []);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
  assert.equal(h.store.findOpen(OWNER, 'question'), null);
});

test('les notes et les mentions revérifient les rôles et ViewChannel au moment de l’action', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Secret du dossier');
  const revoked = await manageAction(h, channel, 'note-list', { freshRoles: [] });
  assert.match(revoked.response.content, /droits ont changé/);
  assert.deepEqual(revoked.response.embeds, []);
  assert.deepEqual(revoked.response.components, []);
  assert.ok(!JSON.stringify(revoked.response).includes('Secret du dossier'));
  const noView = await manageAction(h, channel, 'note-list', { freshPermissions: [] });
  assert.match(noView.response.content, /droits ont changé/);
  assert.ok(!JSON.stringify(noView.response).includes('Secret du dossier'));
  const before = channel.sent.length;
  const modal = interaction(h.guild, {
    kind: 'modal', channel, customId: `${IDS.manageRoleSubmit}${STAFF}:plainte:0:${NEW_ROLE}`,
    detail: 'demande', ...staffAccess, freshRoles: [],
  });
  await h.handle(modal);
  assert.match(modal.response.content, /droits ont changé/);
  assert.equal(channel.sent.length, before);
});

test('une consultation de notes en attente ne révèle rien après retrait du rôle staff', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Note strictement privée');
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const lock = h.service.locks.run(OWNER, async () => { started(); await gate; });
  await running;
  const request = interaction(h.guild, { kind: 'select', channel, customId: `${IDS.manageMenu}${STAFF}`, values: ['note-list'], ...staffAccess });
  request.response = { embeds: [{ stale: 'ancien contenu' }], components: [{ stale: true }] };
  const pending = h.handle(request);
  await Promise.resolve();
  h.guild.memberMap.get(STAFF).roles.cache.clear();
  release();
  await Promise.all([lock, pending]);
  assert.match(request.response.content, /droits ont changé/);
  assert.deepEqual(request.response.embeds, []);
  assert.deepEqual(request.response.components, []);
  assert.ok(!JSON.stringify(request.response).includes('Note strictement privée'));
});

test('les notes internes sont effacées aussi quand le salon est supprimé manuellement', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Secret à détruire');
  await h.service.channelDeleted(channel);
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.deepEqual(h.store.get(channel.id).internalNotes, []);
  assert.ok(!fs.readFileSync(h.config.dataFile, 'utf8').includes('Secret à détruire'));
});

test('une catégorie pleine est signalée et le journal protège les deux types', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  channel.failChannelEdit = Object.assign(new Error('catégorie pleine'), {
    code: 50035, rawError: { errors: { parent_id: { _errors: [{ code: 'CHANNEL_PARENT_MAX_CHANNELS' }] } } },
  });
  const chosen = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'question');
  const failed = await press(h, channel, chosen.response.components[0].toJSON().components[0].custom_id, staffAccess);
  assert.match(failed.response.content, /catégorie Discord est pleine/);
  assert.ok(h.store.get(channel.id).pendingReclassification);
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, channel.id);
  assert.equal(h.store.findOpen(OWNER, 'question').channelId, channel.id);
  assert.equal(channel.parentId, CATEGORIES.plainte);
});

test('si le salon disparaît pendant le changement de catégorie, le registre libère les deux types et les notes', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Ne pas conserver');
  channel.edit = async () => { h.guild.channelMap.delete(channel.id); throw apiError(10003); };
  const chosen = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'question');
  const failed = await press(h, channel, chosen.response.components[0].toJSON().components[0].custom_id, staffAccess);
  assert.match(failed.response.content, /salon.*n’existe plus/);
  assert.equal(h.store.get(channel.id).status, 'deleted');
  assert.deepEqual(h.store.get(channel.id).internalNotes, []);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
  assert.equal(h.store.findOpen(OWNER, 'question'), null);
});

test('le contenu des notes internes est borné et une note vide n’est jamais sauvegardée', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await assert.rejects(h.service.addInternalNote(h.guild, channel.id, STAFF, '  \n '), /doit contenir/);
  await assert.rejects(h.service.addInternalNote(h.guild, channel.id, STAFF, 'x'.repeat(801)), /800 caractères/);
  const notes = Array.from({ length: 100 }, () => ({ authorId: STAFF, createdAt: '2026-01-01T00:00:00.000Z', text: 'note' }));
  h.store.save({ ...h.store.get(channel.id), internalNotes: notes });
  await assert.rejects(h.service.addInternalNote(h.guild, channel.id, STAFF, 'une de trop'), /déjà 100 notes/);
  assert.equal(h.store.get(channel.id).internalNotes.length, 100);
  assert.ok(!JSON.stringify(channel.sent).includes('une de trop'));
});

test('le changement de catégorie et la mention sont refusés si le rôle du staff a été retiré entre-temps', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const selected = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'question');
  const confirm = selected.response.components[0].toJSON().components[0].custom_id;
  const denied = await press(h, channel, confirm, { ...staffAccess, freshRoles: [] });
  assert.match(denied.response.content, /droits ont changé/);
  assert.equal(h.store.get(channel.id).type, 'plainte');
  assert.equal(h.store.get(channel.id).pendingReclassification, null);
  assert.equal(channel.parentId, CATEGORIES.plainte);
  const count = channel.sent.length;
  const modal = interaction(h.guild, { kind: 'modal', channel, customId: `${IDS.manageRoleSubmit}${STAFF}:plainte:0:${NEW_ROLE}`, detail: 'test', ...staffAccess, freshPermissions: [] });
  await h.handle(modal);
  assert.match(modal.response.content, /droits ont changé/);
  assert.equal(channel.sent.length, count);
});

test('après changement de catégorie, les notes internes suivent les nouveaux droits staff', async (t) => {
  const h = harness(t, { rolesStaffParCategorie: { rc_staff: [SPECIAL_ROLE] } });
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Information réservée');
  const chosen = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'rc_staff');
  await press(h, channel, chosen.response.components[0].toJSON().components[0].custom_id, staffAccess);
  const former = await manageAction(h, channel, 'note-list', staffAccess);
  assert.match(former.response.content, /Seule l’équipe/);
  assert.ok(!JSON.stringify(former.response).includes('Information réservée'));
  const current = await manageAction(h, channel, 'note-list', { userId: STAFF, roles: [SPECIAL_ROLE], permissions: [PermissionFlagsBits.ViewChannel] });
  assert.match(current.response.embeds[0].toJSON().description, /Information réservée/);
  assert.deepEqual(current.response.allowedMentions, { parse: [] });
});

test('un ancien renommage en vol ne peut pas écraser le nom de la nouvelle catégorie', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  let release;
  let started;
  channel.renameGate = new Promise((resolve) => { release = resolve; });
  const inFlight = new Promise((resolve) => { started = resolve; });
  channel.onRenameStart = started;
  t.after(() => release());
  await press(h, channel, IDS.claim, { userId: STAFF, roles: [ROLE] });
  await inFlight;
  const chosen = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'question');
  await press(h, channel, chosen.response.components[0].toJSON().components[0].custom_id, staffAccess);
  assert.equal(h.store.get(channel.id).type, 'question');
  release();
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🔴-attente-question-/u);
  assert.equal(channel.renameAttempts.length, 2);
});

test('une mention d’un rôle disparu ou un message trop long ne publie rien', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const count = channel.sent.length;
  h.guild.roles.fetch = async (id) => {
    if (!id) return h.guild.roleMap;
    throw apiError(10011);
  };
  const id = `${IDS.manageRoleSubmit}${STAFF}:plainte:0:${NEW_ROLE}`;
  const missing = interaction(h.guild, { kind: 'modal', channel, customId: id, detail: 'besoin d’aide', ...staffAccess });
  await h.handle(missing);
  assert.match(missing.response.content, /rôle est introuvable/);
  const long = interaction(h.guild, { kind: 'modal', channel, customId: id, detail: 'a'.repeat(601), ...staffAccess });
  await h.handle(long);
  assert.match(long.response.content, /600 caractères/);
  assert.equal(channel.sent.length, count);
});

test('un administrateur qui voit le salon peut consulter les notes sans rôle staff', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Note pour le staff');
  const result = await manageAction(h, channel, 'note-list', {
    userId: STRANGER, roles: [], permissions: [PermissionFlagsBits.Administrator],
  });
  assert.match(result.response.embeds[0].toJSON().description, /Note pour le staff/);
});

test('les actions du menu ne modifient pas le statut ou la priorité après retrait des droits', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const claim = await manageAction(h, channel, 'claim', { freshRoles: [] });
  assert.match(claim.response.content, /droits ont changé/);
  assert.equal(h.store.get(channel.id).status, 'waiting');
  const priority = await choose(h, channel, `${IDS.managePriority}${STAFF}`, 'urgent', { ...staffAccess, freshPermissions: [] });
  assert.match(priority.response.content, /droits ont changé/);
  assert.equal(h.store.get(channel.id).urgent, false);
  const progress = interaction(h.guild, { kind: 'modal', channel, customId: `${IDS.manageProgressSubmit}${STAFF}:plainte:0`, detail: 'enquête', ...staffAccess, freshRoles: [] });
  await h.handle(progress);
  assert.match(progress.response.content, /droits ont changé/);
  assert.equal(h.store.get(channel.id).status, 'waiting');
});

test('la confirmation de reprise depuis le dossier vérifie à nouveau les droits réels', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await press(h, channel, IDS.claim, { userId: STRANGER, roles: [ROLE] });
  const request = await manageAction(h, channel, 'claim');
  const confirm = request.response.components[0].toJSON().components[0].custom_id;
  const denied = await press(h, channel, confirm, { ...staffAccess, freshRoles: [] });
  assert.match(denied.response.content, /droits ont changé/);
  assert.equal(h.store.get(channel.id).assignedTo, STRANGER);
  const accepted = await press(h, channel, confirm, staffAccess);
  assert.match(accepted.response.content, /Pris en charge/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
});

test('au redémarrage, un salon supprimé hors ligne libère le type et efface les notes', async (t) => {
  const h = harness(t);
  const missing = await openTicket(h);
  const present = await openTicket(h, 'question');
  await h.service.addInternalNote(h.guild, missing.channel.id, STAFF, 'Secret à purger après redémarrage');
  await h.service.addInternalNote(h.guild, present.channel.id, STAFF, 'Note du salon présent');
  h.service.stop();
  h.guild.channelMap.delete(missing.channel.id); // Aucun événement ChannelDelete pendant l'arrêt.
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const restarted = new TicketService({ config: h.config, store: reloaded, botUserId: BOT, logger: silentLogger });
  t.after(() => restarted.stop());
  const fetch = h.guild.channels.fetch;
  let listOptions;
  h.guild.channels.fetch = async (id, options) => {
    if (!id) listOptions = options;
    return fetch(id, options);
  };
  await restarted.reconcileMissingChannels(h.guild);
  assert.deepEqual(listOptions, { cache: false });
  assert.equal(reloaded.get(missing.channel.id).status, 'deleted');
  assert.deepEqual(reloaded.get(missing.channel.id).internalNotes, []);
  assert.equal(reloaded.findOpen(OWNER, 'plainte'), null);
  assert.equal(reloaded.get(present.channel.id).internalNotes[0].text, 'Note du salon présent');
  assert.ok(!fs.readFileSync(h.config.dataFile, 'utf8').includes('Secret à purger après redémarrage'));
});

test('une liste incomplète ou une perte d’accès Discord ne supprime jamais les notes', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Note à conserver');
  const fetch = h.guild.channels.fetch;
  h.guild.channels.fetch = async (id, options) => {
    if (!id) return new Map(); // Salon omis de la liste, mais pas forcément supprimé.
    if (id === channel.id) throw apiError(50001); // Accès manquant, pas Unknown Channel.
    return fetch(id, options);
  };
  await h.service.reconcileMissingChannels(h.guild);
  assert.equal(h.store.get(channel.id).status, 'waiting');
  assert.equal(h.store.get(channel.id).internalNotes[0].text, 'Note à conserver');
  assert.equal(h.store.findOpen(OWNER, 'plainte').channelId, channel.id);
  h.guild.channels.fetch = async () => { throw new Error('Discord indisponible'); };
  await h.service.reconcileMissingChannels(h.guild);
  assert.equal(h.store.get(channel.id).internalNotes[0].text, 'Note à conserver');
});

test('le bouton prend puis laisse le ticket sans toucher à la fermeture ou aux autres fonctions', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const button = assignmentButton(h, channel);
  assert.equal(button.label, 'Prendre en charge / laisser');
  const denied = await press(h, channel, button.custom_id, { userId: OWNER });
  assert.match(denied.response.content, /Seule l’équipe/);
  assert.equal(h.store.get(channel.id).assignedTo, null);

  const taken = await press(h, channel, button.custom_id, staffAccess);
  assert.match(taken.response.content, /pris ce ticket en charge/);
  assert.equal(taken.deferOptions.flags, MessageFlags.Ephemeral);
  assert.equal(h.store.get(channel.id).status, 'claimed');
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  assert.equal(h.store.get(channel.id).assignmentRevision, 1);
  const current = assignmentButton(h, channel);
  assert.notEqual(current.custom_id, button.custom_id);
  const stale = await press(h, channel, button.custom_id, staffAccess);
  assert.match(stale.response.content, /responsable a changé/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);

  await h.service.setStatus(h.guild, channel.id, 'progress', STAFF, 'analyse du dossier');
  await h.service.setUrgent(h.guild, channel.id, true, STAFF);
  await h.service.addInternalNote(h.guild, channel.id, STAFF, 'Note conservée');
  const released = await press(h, channel, assignmentButton(h, channel).custom_id, staffAccess);
  assert.match(released.response.content, /laissé ce ticket/);
  const ticket = h.store.get(channel.id);
  assert.equal(ticket.status, 'waiting');
  assert.equal(ticket.assignedTo, null);
  assert.equal(ticket.progressDetail, null);
  assert.equal(ticket.assignmentRevision, 2);
  assert.equal(ticket.urgent, true);
  assert.equal(ticket.internalNotes[0].text, 'Note conservée');
  assert.equal(h.guild.channelMap.has(channel.id), true);
  const ids = channel.messageMap.get(ticket.panelMessageId).payload.components[0].toJSON().components.map((item) => item.custom_id);
  assert.ok(ids.includes(IDS.manage));
  assert.ok(ids.includes(IDS.close));
  await waitForName(h.store, channel);
  assert.match(channel.name, /^🔴-attente-/u);
});

test('un autre membre du staff ne peut reprendre le ticket qu’après confirmation', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  await press(h, channel, assignmentButton(h, channel).custom_id, staffAccess);
  const otherStaff = { ...staffAccess, userId: STRANGER };
  const conflict = await press(h, channel, assignmentButton(h, channel).custom_id, otherStaff);
  assert.match(conflict.response.content, /déjà attribué/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  const confirmId = conflict.response.components[0].toJSON().components[0].custom_id;
  const denied = await press(h, channel, confirmId, staffAccess);
  assert.match(denied.response.content, /ne vous appartient pas/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  const accepted = await press(h, channel, confirmId, otherStaff);
  assert.match(accepted.response.content, /Pris en charge/);
  assert.equal(h.store.get(channel.id).assignedTo, STRANGER);
  const released = await press(h, channel, assignmentButton(h, channel).custom_id, otherStaff);
  assert.match(released.response.content, /laissé ce ticket/);
  assert.equal(h.store.get(channel.id).status, 'waiting');
  assert.equal(h.store.get(channel.id).assignedTo, null);
});

test('deux clics simultanés sur le même bouton ne prennent puis ne laissent pas le ticket', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const customId = assignmentButton(h, channel).custom_id;
  const first = interaction(h.guild, { channel, customId, ...staffAccess });
  const second = interaction(h.guild, { channel, customId, ...staffAccess });
  await Promise.all([h.handle(first), h.handle(second)]);
  assert.equal([first, second].filter((item) => /pris ce ticket en charge/.test(item.response.content)).length, 1);
  assert.equal([first, second].filter((item) => /responsable a changé/.test(item.response.content)).length, 1);
  assert.equal(h.store.get(channel.id).status, 'claimed');
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  assert.equal(h.store.get(channel.id).assignmentRevision, 1);
});

test('le bouton direct respecte les droits actuels et refuse les anciennes catégories', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const original = assignmentButton(h, channel).custom_id;
  const noView = await press(h, channel, original, { ...staffAccess, permissions: [] });
  assert.match(noView.response.content, /voir ce salon/);
  const revoked = await press(h, channel, original, { ...staffAccess, freshRoles: [] });
  assert.match(revoked.response.content, /droits ont changé/);
  assert.equal(h.store.get(channel.id).assignedTo, null);
  const invalid = await press(h, channel, `${IDS.assignmentToggle}plainte:0:abc`, staffAccess);
  assert.match(invalid.response.content, /expiré/);
  const selected = await choose(h, channel, `${IDS.manageCategory}${STAFF}`, 'question');
  await press(h, channel, selected.response.components[0].toJSON().components[0].custom_id, staffAccess);
  const stale = await press(h, channel, original, staffAccess);
  assert.match(stale.response.content, /catégorie du ticket a changé/);
  assert.equal(h.store.get(channel.id).type, 'question');
  assert.equal(h.store.get(channel.id).assignedTo, null);
  const fresh = await press(h, channel, assignmentButton(h, channel).custom_id, staffAccess);
  assert.match(fresh.response.content, /pris ce ticket en charge/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
});

test('les panneaux de version 4 retrouvent le bouton sans nouvelle mention', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const ticket = h.store.get(channel.id);
  h.store.save({ ...ticket, panelVersion: 4 });
  const panel = channel.messageMap.get(ticket.panelMessageId);
  const row = panel.payload.components[0].toJSON();
  row.components = row.components.filter((item) => !item.custom_id.startsWith(IDS.assignmentToggle));
  panel.payload.components = [{ toJSON: () => row }];
  assert.equal(assignmentButton(h, channel), undefined);
  const messagesBefore = channel.sent.length;
  await h.service.refreshOutdatedPanels(h.guild);
  assert.equal(h.store.get(channel.id).panelVersion, 5);
  assert.equal(assignmentButton(h, channel).label, 'Prendre en charge / laisser');
  assert.equal(channel.sent.length, messagesBefore);
  assert.deepEqual(panel.payload.allowedMentions, { parse: [] });
});

test('des clics simultanés de deux membres du staff ne transfèrent pas silencieusement le ticket', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const customId = assignmentButton(h, channel).custom_id;
  const first = interaction(h.guild, { channel, customId, ...staffAccess });
  const second = interaction(h.guild, { channel, customId, ...staffAccess, userId: STRANGER });
  await Promise.all([h.handle(first), h.handle(second)]);
  assert.equal([first, second].filter((item) => /pris ce ticket en charge/.test(item.response.content)).length, 1);
  assert.equal([first, second].filter((item) => /responsable a changé/.test(item.response.content)).length, 1);
  const winner = h.store.get(channel.id).assignedTo;
  assert.ok([STAFF, STRANGER].includes(winner));
  assert.equal(h.store.get(channel.id).assignmentRevision, 1);
});

test('si le panneau ne s’actualise pas, son ancien bouton ne peut pas annuler la prise en charge', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const ticket = h.store.get(channel.id);
  const panel = channel.messageMap.get(ticket.panelMessageId);
  const staleId = assignmentButton(h, channel).custom_id;
  panel.failEdit = true;
  const taken = await press(h, channel, staleId, staffAccess);
  assert.match(taken.response.content, /panneau n’a pas pu être actualisé/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  const stale = await press(h, channel, staleId, staffAccess);
  assert.match(stale.response.content, /ticket-panneau/);
  assert.equal(h.store.get(channel.id).assignedTo, STAFF);
  panel.failEdit = false;
  await h.service.repair(h.guild, channel.id);
  assert.notEqual(assignmentButton(h, channel).custom_id, staleId);
  const released = await press(h, channel, assignmentButton(h, channel).custom_id, staffAccess);
  assert.match(released.response.content, /laissé ce ticket/);
  assert.equal(h.store.get(channel.id).status, 'waiting');
});

test('le bouton refuse sans modifier le ticket si le compteur d’attribution est épuisé', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const original = h.store.get(channel.id);
  h.store.save({ ...original, assignmentRevision: Number.MAX_SAFE_INTEGER });
  await h.service.repair(h.guild, channel.id);
  const item = await press(h, channel, assignmentButton(h, channel).custom_id, staffAccess);
  assert.match(item.response.content, /compteur d’attribution est épuisé/);
  assert.equal(h.store.get(channel.id).status, 'waiting');
  assert.equal(h.store.get(channel.id).assignedTo, null);
});

test('le bouton ne peut pas modifier un ancien ticket fermé ni fonctionner sur un autre serveur', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const customId = assignmentButton(h, channel).custom_id;
  const foreign = interaction(h.guild, { channel, customId, ...staffAccess, guildId: OTHER_GUILD });
  await h.handle(foreign);
  assert.equal(foreign.response, null);
  assert.equal(h.store.get(channel.id).assignedTo, null);
  await makeLegacyClosed(h, channel);
  const closed = await press(h, channel, customId, staffAccess);
  assert.match(closed.response.content, /ticket est fermé/);
  assert.equal(h.store.get(channel.id).status, 'closed');
  assert.equal(h.store.get(channel.id).assignedTo, null);
});

test('les droits sont revérifiés après l’attente du verrou du ticket', async (t) => {
  const h = harness(t);
  const { channel } = await openTicket(h);
  const customId = assignmentButton(h, channel).custom_id;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const locked = h.service.locks.run(OWNER, async () => { started(); await gate; });
  await running;
  const click = interaction(h.guild, { channel, customId, ...staffAccess });
  const pending = h.handle(click);
  await Promise.resolve();
  h.guild.memberMap.get(STAFF).roles.cache.clear();
  release();
  await Promise.all([locked, pending]);
  assert.match(click.response.content, /droits ont changé/);
  assert.equal(h.store.get(channel.id).assignedTo, null);
  assert.equal(h.store.get(channel.id).status, 'waiting');
});

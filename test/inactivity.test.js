import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType, MessagePayload, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { INACTIVITY_DELAY_MS as DAY, INACTIVITY_RETRY_MS, InactivityMonitor, inactivityDueAt, latestHumanMessageSince } from '../src/inactivity.js';
import { loadConfig } from '../src/config.js';
import { TicketStore } from '../src/store.js';
import { TicketService } from '../src/ticket-service.js';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const OWNER = '110000000000000001';
const STAFF = '110000000000000002';
const BOT = '110000000000000003';
const ROLE = '200000000000000001';
const CHANNEL = '400000000000000001';
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels];
const silent = { error() {}, warn() {} };
let messageCounter = 0n;
const nextMessageId = (timestamp) => String(BigInt(timestamp) * 1_000_000n + (++messageCounter % 1_000_000n));
const iso = (timestamp) => new Date(timestamp).toISOString();
const discordError = (code) => Object.assign(new Error(`Discord ${code}`), { code });

function ticket(createdAt = BASE) {
  return {
    channelId: CHANNEL, number: 1, type: 'plainte', ownerId: OWNER, ownerName: 'Membre',
    status: 'waiting', assignedTo: null, progressDetail: null, assignmentRevision: 0, categoryRevision: 0,
    staffRoleIds: [ROLE], panelMessageId: null, panelVersion: 6, urgent: false,
    createdAt: iso(createdAt), updatedAt: iso(createdAt), closedAt: null, closedPermissions: null, deletedAt: null,
    pendingDeletion: null, pendingTransition: null, pendingReclassification: null,
    lastActivityAt: iso(createdAt), inactivityReminder: null,
    internalNotes: [{ authorId: STAFF, createdAt: iso(createdAt), text: 'note interne privée' }],
  };
}

function harness(t, { legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madrid-inactivity-'));
  const clock = { now: BASE };
  const config = loadConfig({
    token: 'fake-token', serveurId: GUILD, rolesStaff: [ROLE],
    categories: {
      plainte: '300000000000000001', question: '300000000000000002', rc_staff: '300000000000000003',
      demande_unban: '300000000000000004', fondation: '300000000000000005', partenariat: '300000000000000006',
    },
    rolesStaffParCategorie: {},
  }, dir);
  const store = new TicketStore(config.dataFile, GUILD);
  store.allocateNumber();
  const item = ticket();
  if (legacy) { delete item.lastActivityAt; delete item.inactivityReminder; }
  store.save(item);
  const guild = { id: GUILD, channelMap: new Map() };
  guild.roles = { fetch: async () => new Map([[ROLE, { id: ROLE }]]) };
  guild.members = { fetchMe: async () => ({ id: BOT }) };
  const channel = {
    id: CHANNEL, guildId: GUILD, guild, type: ChannelType.GuildText,
    history: [], sent: [], deleteReasons: [], historyCalls: 0, bits: [...permissions],
    permissionsFor() { return new PermissionsBitField(this.bits); },
    addMessage(timestamp, { bot = false, authorId = OWNER, webhookId = null, channelId = CHANNEL, guildId = GUILD } = {}) {
      const message = {
        id: nextMessageId(timestamp), guildId, channelId, createdTimestamp: timestamp,
        author: { id: authorId, bot }, webhookId,
      };
      this.history.push(message);
      return message;
    },
    async send(payload) {
      if (this.sendGate) {
        const gate = this.sendGate;
        this.sendGate = null;
        this.onSendStart?.();
        await gate;
      }
      if (this.failSend && !this.deliverBeforeError) throw new Error('envoi Discord impossible');
      const old = payload.enforceNonce && this.sent.find((entry) => entry.payload.nonce === payload.nonce);
      let entry = old;
      if (!entry) {
        const message = this.addMessage(clock.now, { bot: true, authorId: BOT });
        entry = { payload, message };
        this.sent.push(entry);
      }
      if (this.failSend) throw new Error('réponse Discord perdue');
      return entry.message;
    },
    async delete(reason) {
      this.deleteReasons.push(reason);
      if (this.failDelete) throw new Error('suppression refusée');
      guild.channelMap.delete(CHANNEL);
      this.deleted = true;
    },
  };
  channel.messages = {
    fetch: async ({ before, limit, cache, message }) => {
      channel.historyCalls++;
      channel.lastFetchOptions = { before, limit, cache };
      if (channel.failHistory) throw new Error('historique indisponible');
      if (message) {
        const found = channel.history.find((item) => item.id === message);
        if (!found) throw discordError(10008);
        return found;
      }
      const sorted = [...channel.history].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
      const filtered = before ? sorted.filter((message) => BigInt(message.id) < BigInt(before)) : sorted;
      const snapshot = new Map(filtered.slice(0, limit).map((message) => [message.id, message]));
      if (channel.historyGate) {
        const gate = channel.historyGate;
        channel.historyGate = null;
        channel.onHistoryStart?.();
        await gate;
      }
      return snapshot;
    },
  };
  guild.channelMap.set(CHANNEL, channel);
  guild.channels = { fetch: async (id) => {
    if (!id) return new Map(guild.channelMap);
    const found = guild.channelMap.get(id);
    if (!found) throw discordError(10003);
    return found;
  } };
  const services = [];
  function makeService(selectedStore = store) {
    const service = new TicketService({ config, store: selectedStore, botUserId: BOT, logger: silent, clock: () => clock.now });
    services.push(service);
    return service;
  }
  const service = makeService();
  t.after(() => { for (const item of services) item.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { config, store, guild, channel, clock, service, makeService };
}

async function record(h, timestamp, options = {}) {
  const message = h.channel.addMessage(timestamp, options);
  await h.service.recordMessageActivity(message);
  return message;
}

test('24 h d’inactivité envoient un rappel, puis 24 h sans message suppriment le salon', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY - 1;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 0);
  h.clock.now++;
  assert.deepEqual(await h.service.checkInactivity(h.guild, CHANNEL), { reminded: true });
  assert.equal(h.channel.sent.length, 1);
  const payload = h.channel.sent[0].payload;
  assert.match(payload.content, new RegExp(`<@${OWNER}>`));
  assert.match(payload.content, /24 h.*supprimés.*sans transcription/);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [OWNER] });
  assert.equal(payload.enforceNonce, true);
  assert.match(payload.nonce, /^[a-f0-9]{24}$/);
  const body = MessagePayload.create({ client: { options: {} } }, payload).resolveBody().body;
  assert.equal(body.enforce_nonce, true);
  assert.deepEqual(body.allowed_mentions, { parse: [], users: [OWNER] });
  assert.equal(h.store.get(CHANNEL).inactivityReminder.state, 'sent');
  assert.equal(new TicketStore(h.config.dataFile, GUILD).get(CHANNEL).inactivityReminder.state, 'sent');
  h.clock.now = BASE + 2 * DAY - 1;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
  h.clock.now++;
  assert.deepEqual(await h.service.checkInactivity(h.guild, CHANNEL), { deleted: true });
  const deleted = h.store.get(CHANNEL);
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.deletedBy, BOT);
  assert.deepEqual(deleted.internalNotes, []);
  assert.equal(deleted.inactivityReminder, null);
  assert.equal(h.store.findOpen(OWNER, 'plainte'), null);
  assert.match(h.channel.deleteReasons[0], /automatique.*inactivité/);
});

test('tout message humain du salon remet le délai à zéro, mais pas les bots ni les webhooks', async (t) => {
  const h = harness(t);
  const first = BASE + 23 * 60 * 60 * 1000;
  await record(h, first, { authorId: STAFF });
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(first));
  await record(h, first + 1000, { bot: true, authorId: BOT });
  await record(h, first + 2000, { webhookId: '900000000000000001' });
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(first));
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 0);
  h.clock.now = first + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 1);
  const reply = h.clock.now + 2 * 60 * 60 * 1000;
  await record(h, reply);
  assert.equal(h.store.get(CHANNEL).inactivityReminder, null);
  h.clock.now += DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(h.channel.sent.length, 1);
  h.clock.now = reply + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 2);
  assert.equal(h.store.get(CHANNEL).inactivityReminder.state, 'sent');
});

test('les messages reçus hors ligne sont vérifiés avant rappel et avant suppression', async (t) => {
  const h = harness(t, { legacy: true });
  h.service.stop();
  const first = BASE + 23 * 60 * 60 * 1000;
  h.channel.addMessage(first, { authorId: STAFF });
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = h.makeService(reloaded);
  h.clock.now = BASE + DAY;
  await service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 0);
  assert.equal(reloaded.get(CHANNEL).lastActivityAt, iso(first));
  h.clock.now = first + DAY;
  await service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 1);
  service.stop();
  const reply = h.clock.now + 3 * 60 * 60 * 1000;
  h.channel.addMessage(reply);
  const afterRestart = new TicketStore(h.config.dataFile, GUILD);
  const restarted = h.makeService(afterRestart);
  h.clock.now = first + 2 * DAY;
  await restarted.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(afterRestart.get(CHANNEL).inactivityReminder, null);
  assert.equal(afterRestart.get(CHANNEL).lastActivityAt, iso(reply));
  h.clock.now = reply + DAY;
  await restarted.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 2);
  h.clock.now += DAY;
  await restarted.checkInactivity(h.guild, CHANNEL);
  assert.equal(afterRestart.get(CHANNEL).status, 'deleted');
});

test('un arrêt prolongé avant le premier rappel ne ferme jamais le salon sans avertissement', async (t) => {
  const h = harness(t, { legacy: true });
  h.clock.now = BASE + 10 * DAY;
  const result = await h.service.checkInactivity(h.guild, CHANNEL);
  assert.deepEqual(result, { reminded: true });
  assert.equal(h.channel.deleted, undefined);
  assert.equal(h.store.get(CHANNEL).inactivityReminder.sentAt, iso(h.clock.now));
  h.clock.now += DAY - 1;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
});

test('permissions ou historique indisponibles bloquent rappel et suppression', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  h.channel.bits = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels];
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /Permissions insuffisantes/);
  assert.equal(h.channel.sent.length, 0);
  h.channel.bits = [...permissions];
  h.channel.failHistory = true;
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /historique indisponible/);
  assert.equal(h.channel.sent.length, 0);
  h.channel.failHistory = false;
  await h.service.checkInactivity(h.guild, CHANNEL);
  h.clock.now += DAY;
  h.channel.bits = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages];
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /Permissions insuffisantes/);
  assert.equal(h.channel.deleted, undefined);
  h.channel.bits = [...permissions];
  h.channel.failHistory = true;
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /historique indisponible/);
  assert.equal(h.store.get(CHANNEL).status, 'waiting');
});

test('la pagination détecte une réponse derrière plus de 100 messages de bots', async (t) => {
  const h = harness(t);
  const humanAt = BASE + 23 * 60 * 60 * 1000;
  h.channel.addMessage(humanAt, { authorId: STAFF });
  for (let i = 1; i <= 150; i++) h.channel.addMessage(humanAt + i, { bot: true });
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.ok(h.channel.historyCalls >= 2);
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(humanAt));
  assert.equal(h.channel.sent.length, 0);
  assert.equal(h.channel.lastFetchOptions.cache, false);
});

test('si l’historique est trop volumineux ou mal formé, aucune fermeture ne se produit', async (t) => {
  const h = harness(t);
  for (let i = 1; i <= 1001; i++) h.channel.addMessage(BASE + i, { bot: true });
  h.clock.now = BASE + DAY;
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /historique trop volumineux/i);
  assert.equal(h.channel.sent.length, 0);
  assert.equal(h.channel.deleted, undefined);
  h.channel.history = [{ id: 'pas-un-id', createdTimestamp: BASE + 1, author: { bot: false } }];
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /ne permet pas de vérifier/);
  assert.equal(h.channel.deleted, undefined);
});

test('un rappel à l’envoi incertain est journalisé et retenté sans fermeture anticipée', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  h.channel.failSend = true;
  h.channel.deliverBeforeError = true;
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /réponse Discord perdue/);
  const pending = h.store.get(CHANNEL).inactivityReminder;
  assert.equal(pending.state, 'sending');
  assert.equal(h.channel.sent.length, 1);
  h.channel.failSend = false;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 1);
  h.clock.now += INACTIVITY_RETRY_MS;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 1, 'Le même nonce permet la déduplication Discord simulée.');
  assert.equal(h.channel.sent[0].payload.nonce, pending.nonce);
  assert.equal(h.store.get(CHANNEL).inactivityReminder.state, 'sent');
  assert.equal(h.store.get(CHANNEL).inactivityReminder.sentAt, iso(h.clock.now));
  h.clock.now += DAY - 1;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
  h.clock.now++;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, true);
});

test('un message reçu pendant l’envoi du rappel annule la future fermeture', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  let release;
  let started;
  h.channel.sendGate = new Promise((resolve) => { release = resolve; });
  const sending = new Promise((resolve) => { started = resolve; });
  h.channel.onSendStart = started;
  t.after(() => release());
  const check = h.service.checkInactivity(h.guild, CHANNEL);
  await sending;
  const msg = h.channel.addMessage(h.clock.now);
  const incoming = h.service.recordMessageActivity(msg);
  release();
  await Promise.all([check, incoming]);
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(h.clock.now));
  assert.equal(h.store.get(CHANNEL).inactivityReminder, null);
  h.clock.now += DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(h.channel.sent.length, 2);
});

test('un message reçu pendant la vérification finale empêche la suppression', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  h.clock.now += DAY;
  let release;
  let started;
  h.channel.historyGate = new Promise((resolve) => { release = resolve; });
  const fetching = new Promise((resolve) => { started = resolve; });
  h.channel.onHistoryStart = started;
  t.after(() => release());
  const check = h.service.checkInactivity(h.guild, CHANNEL);
  await fetching;
  const message = h.channel.addMessage(h.clock.now);
  const incoming = h.service.recordMessageActivity(message);
  release();
  await Promise.all([check, incoming]);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(h.store.get(CHANNEL).inactivityReminder, null);
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(h.clock.now));
});

test('un échec de fermeture ne supprime rien et une réponse ultérieure annule le rappel', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  h.clock.now += DAY;
  h.channel.failDelete = true;
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /salon n’a pas été supprimé/);
  assert.equal(h.store.get(CHANNEL).pendingDeletion, null);
  assert.equal(h.store.get(CHANNEL).status, 'waiting');
  h.channel.failDelete = false;
  await record(h, h.clock.now + 1000);
  h.clock.now += 2000;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(h.store.get(CHANNEL).inactivityReminder, null);
});

test('messages étrangers, anciens, de bots et de fils ne modifient pas l’activité du ticket', async (t) => {
  const h = harness(t);
  await h.service.recordMessageActivity({ guildId: OTHER_GUILD, channelId: CHANNEL, author: { bot: false }, createdTimestamp: BASE + 100 });
  await h.service.recordMessageActivity({ guildId: GUILD, channelId: '400000000000000099', author: { bot: false }, createdTimestamp: BASE + 200 });
  await h.service.recordMessageActivity({ guildId: GUILD, channelId: CHANNEL, author: { bot: true }, createdTimestamp: BASE + 300 });
  await h.service.recordMessageActivity({ guildId: GUILD, channelId: CHANNEL, author: { bot: false }, createdTimestamp: BASE - 100 });
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(BASE));
  await record(h, BASE + 1000);
  await record(h, BASE + 500, { authorId: STAFF });
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(BASE + 1000));
});

test('tickets fermés ou opérations interrompues sont exclus du traitement automatique', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + 10 * DAY;
  const original = h.store.get(CHANNEL);
  h.store.save({ ...original, pendingDeletion: { actorId: OWNER, requestedAt: iso(BASE) } });
  assert.equal(inactivityDueAt(h.store.get(CHANNEL)), Infinity);
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 0);
  h.store.save({ ...original, pendingTransition: { ownerWrites: null } });
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 0);
  h.store.save({ ...original, pendingReclassification: { targetType: 'question', actorId: STAFF, requestedAt: iso(BASE), candidateRoleIds: [ROLE] } });
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 0);
  h.store.save({ ...original, status: 'closed', closedAt: iso(BASE), closedPermissions: {
    SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null, CreatePrivateThreads: null,
  } });
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 0);
  assert.equal(h.channel.deleted, undefined);
});

test('le moniteur évite les passages simultanés et retente après une erreur', async () => {
  let now = BASE + DAY;
  let calls = 0;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  const service = {
    stopped: false, store: { list: () => [ticket()] },
    async checkInactivity() { calls++; started(); await gate; throw new Error('temporaire'); },
  };
  const monitor = new InactivityMonitor({ guild: { id: GUILD }, service, logger: silent, clock: () => now });
  monitor.stopped = false;
  const first = monitor.run();
  await running;
  await monitor.run();
  assert.equal(calls, 1);
  release();
  await first;
  await monitor.run();
  assert.equal(calls, 1);
  now += INACTIVITY_RETRY_MS;
  await monitor.run();
  assert.equal(calls, 2);
  monitor.stop();
});

test('la lecture d’historique refuse une page qui ne permet pas de déterminer l’auteur', async () => {
  const channel = { messages: { fetch: async () => new Map([['123456789012345678', {
    id: '123456789012345678', createdTimestamp: BASE, author: null,
  }]]) } };
  await assert.rejects(latestHumanMessageSince(channel, BASE - 1), /ne permet pas de vérifier/);
});

test('si le rappel automatique a été supprimé, un nouveau rappel précède la fermeture', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  const warningId = h.store.get(CHANNEL).inactivityReminder.messageId;
  h.channel.history = h.channel.history.filter((message) => message.id !== warningId);
  h.clock.now += DAY;
  assert.deepEqual(await h.service.checkInactivity(h.guild, CHANNEL), { reminded: true });
  assert.equal(h.channel.deleted, undefined);
  assert.equal(h.channel.sent.length, 2);
  assert.notEqual(h.store.get(CHANNEL).inactivityReminder.messageId, warningId);
  h.clock.now += DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, true);
});

test('une erreur disque après l’envoi n’autorise jamais une suppression sans rappel confirmé', async (t) => {
  const h = harness(t);
  const save = h.store.save.bind(h.store);
  h.store.save = (record) => {
    if (record.inactivityReminder?.state === 'sent') throw new Error('disque indisponible');
    return save(record);
  };
  h.clock.now = BASE + DAY;
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /disque indisponible/);
  assert.equal(h.channel.sent.length, 1);
  assert.equal(h.store.get(CHANNEL).inactivityReminder.state, 'sending');
  h.service.stop();
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = h.makeService(reloaded);
  h.clock.now = BASE + 10 * DAY;
  await service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(reloaded.get(CHANNEL).inactivityReminder.state, 'sent');
  assert.equal(reloaded.get(CHANNEL).inactivityReminder.sentAt, iso(h.clock.now));
  h.clock.now += DAY - 1;
  await service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
});

test('une suppression Discord confirmée puis interrompue sur disque est finalisée au redémarrage', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  h.clock.now += DAY;
  const markDeleted = h.store.markDeleted.bind(h.store);
  h.store.markDeleted = () => { throw new Error('écriture impossible'); };
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /écriture impossible/);
  assert.equal(h.channel.deleted, true);
  assert.equal(h.store.get(CHANNEL).pendingDeletion.actorId, BOT);
  h.store.markDeleted = markDeleted;
  h.service.stop();
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const service = h.makeService(reloaded);
  await service.recoverPendingDeletions(h.guild);
  assert.equal(reloaded.get(CHANNEL).status, 'deleted');
  assert.equal(reloaded.get(CHANNEL).deletedBy, BOT);
  assert.deepEqual(reloaded.get(CHANNEL).internalNotes, []);
});

test('le moniteur ignore les tickets non dus et continue après l’erreur d’un salon', async () => {
  const seen = [];
  const one = ticket();
  const two = { ...ticket(), channelId: '400000000000000002', number: 2 };
  const three = { ...ticket(BASE + DAY), channelId: '400000000000000003', number: 3 };
  const service = {
    stopped: false,
    store: { list: () => [one, two, three] },
    async checkInactivity(guild, id) {
      seen.push(id);
      if (id === one.channelId) throw new Error('erreur réseau');
    },
  };
  const monitor = new InactivityMonitor({ guild: { id: GUILD }, service, logger: silent, clock: () => BASE + DAY });
  monitor.stopped = false;
  await monitor.run();
  assert.deepEqual(seen, [one.channelId, two.channelId]);
  monitor.stop();
});

test('le registre valide les dates et ne permet pas un rappel anticipé ou incohérent', async (t) => {
  const h = harness(t);
  const original = h.store.get(CHANNEL);
  for (const change of [
    { lastActivityAt: 'date invalide' },
    { lastActivityAt: iso(BASE - 1) },
    { inactivityReminder: { state: 'sent', activityAt: iso(BASE), sentAt: iso(BASE + DAY - 1), messageId: '500000000000000001' } },
    { inactivityReminder: { state: 'sending', activityAt: iso(BASE), attemptedAt: iso(BASE + DAY), nonce: 'invalide' } },
    { inactivityReminder: { state: 'sent', activityAt: iso(BASE + 100), sentAt: iso(BASE + DAY + 100), messageId: '500000000000000001' } },
    { inactivityReminder: { state: 'sent', activityAt: iso(BASE), sentAt: iso(BASE + DAY), messageId: 'mauvais-id' } },
  ]) assert.throws(() => h.store.save({ ...original, ...change }), /ticket invalide/);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(new TicketStore(h.config.dataFile, GUILD).get(CHANNEL).inactivityReminder.state, 'sent');
});

test('une réponse après un envoi incertain annule le journal de rappel avant toute relance', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  h.channel.failSend = true;
  await assert.rejects(h.service.checkInactivity(h.guild, CHANNEL), /envoi Discord impossible/);
  assert.equal(h.store.get(CHANNEL).inactivityReminder.state, 'sending');
  h.channel.failSend = false;
  const messageAt = h.clock.now + 1000;
  h.channel.addMessage(messageAt, { authorId: STAFF }); // Réponse pendant une interruption, sans événement.
  h.clock.now += INACTIVITY_RETRY_MS;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.sent.length, 0);
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(messageAt));
  assert.equal(h.store.get(CHANNEL).inactivityReminder, null);
});

test('un message reçu pendant la vérification du rappel bloque aussi la suppression', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  h.clock.now += DAY;
  const fetch = h.channel.messages.fetch;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const readingReminder = new Promise((resolve) => { started = resolve; });
  h.channel.messages.fetch = async (options) => {
    const value = await fetch(options);
    if (options.message) { started(); await gate; }
    return value;
  };
  t.after(() => release());
  const check = h.service.checkInactivity(h.guild, CHANNEL);
  await readingReminder;
  const message = h.channel.addMessage(h.clock.now);
  const incoming = h.service.recordMessageActivity(message);
  release();
  await Promise.all([check, incoming]);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(h.store.get(CHANNEL).inactivityReminder, null);
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(h.clock.now));
});

test('le moniteur démarre immédiatement et s’arrête sans laisser de minuterie active', async () => {
  let calls = 0;
  let notify;
  const checked = new Promise((resolve) => { notify = resolve; });
  const service = {
    stopped: false, store: { list: () => [ticket()] },
    async checkInactivity() { calls++; notify(); },
  };
  const monitor = new InactivityMonitor({ guild: { id: GUILD }, service, logger: silent, clock: () => BASE + DAY, intervalMs: 1000 });
  monitor.start();
  await checked;
  monitor.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(monitor.stopped, true);
  assert.equal(monitor.timer, null);
});

test('une ancienne réponse manquée relance un avertissement au lieu de fermer au redémarrage', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  h.service.stop();
  h.channel.addMessage(BASE + DAY + 1000);
  const reloaded = new TicketStore(h.config.dataFile, GUILD);
  const restarted = h.makeService(reloaded);
  h.clock.now = BASE + 5 * DAY;
  assert.deepEqual(await restarted.checkInactivity(h.guild, CHANNEL), { reminded: true });
  assert.equal(h.channel.sent.length, 2);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(reloaded.get(CHANNEL).inactivityReminder.sentAt, iso(h.clock.now));
});

test('une réponse non encore reçue par la passerelle pendant le contrôle du rappel est retrouvée avant suppression', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  h.clock.now += DAY;
  const fetch = h.channel.messages.fetch;
  h.channel.messages.fetch = async (options) => {
    const result = await fetch(options);
    if (options.message) h.channel.addMessage(h.clock.now, { authorId: STAFF });
    return result;
  };
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, undefined);
  assert.equal(h.store.get(CHANNEL).inactivityReminder, null);
  assert.equal(h.store.get(CHANNEL).lastActivityAt, iso(h.clock.now));
});

test('un rappel manuel après l’avertissement automatique ne prolonge pas le délai', async (t) => {
  const h = harness(t);
  h.clock.now = BASE + DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  const automatic = h.store.get(CHANNEL).inactivityReminder;
  h.clock.now += DAY / 2;
  await h.service.remindOwner(h.guild, CHANNEL, STAFF);
  assert.deepEqual(h.store.get(CHANNEL).inactivityReminder, automatic);
  h.clock.now = BASE + 2 * DAY;
  await h.service.checkInactivity(h.guild, CHANNEL);
  assert.equal(h.channel.deleted, true);
});

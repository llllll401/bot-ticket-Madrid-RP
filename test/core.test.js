import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApplicationCommandType, ChannelType, Collection, DiscordAPIError, PermissionFlagsBits, PermissionOverwrites, PermissionsBitField, RateLimitError, REST } from 'discord.js';
import { channelName, slugify, statusLabel, TICKET_TYPES } from '../src/catalog.js';
import { commands } from '../src/commands.js';
import { loadConfig, loadConfigFile } from '../src/config.js';
import { isFullCategory, isServerChannelLimit } from '../src/errors.js';
import { KeyedLock } from '../src/lock.js';
import { rejectChannelRenameRateLimit } from '../src/name-sync.js';
import { REQUIRED_BOT_PERMISSIONS, ticketOverwrites, validateGuildConfiguration } from '../src/permissions.js';
import { registerGuildCommands } from '../src/register.js';
import { TicketStore } from '../src/store.js';
import { IDS, publicPanel, ticketPanel } from '../src/ui.js';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const ROLE = '200000000000000001';
const SPECIAL_ROLE = '200000000000000002';
const PARENT = '300000000000000001';
const OWNER = '400000000000000001';
const BOT = '400000000000000002';
const CHANNEL = '500000000000000001';

const CATEGORIES = Object.freeze({
  plainte: PARENT,
  question: '300000000000000002',
  rc_staff: '300000000000000003',
  demande_unban: '300000000000000004',
  fondation: '300000000000000005',
  partenariat: '300000000000000006',
});

function configData(overrides = {}) {
  return {
    token: 'fake-token', serveurId: GUILD, rolesStaff: [ROLE], categories: { ...CATEGORIES },
    rolesStaffParCategorie: {}, fichierDonnees: './data/tickets.json', ...overrides,
  };
}

function record(number = 1) {
  return {
    channelId: CHANNEL, number, type: 'plainte', ownerId: OWNER, ownerName: 'Élodie 👑',
    status: 'waiting', assignedTo: null, progressDetail: null, staffRoleIds: [ROLE], panelMessageId: null,
    createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z',
    closedAt: null, closedPermissions: null, deletedAt: null,
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madrid-tickets-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('le catalogue et le menu proposent exactement les six catégories demandées', () => {
  const expected = ['Plainte', 'Question', 'RC STAFF', 'Demande UNBAN', 'Fondation', 'Partenariat'];
  assert.deepEqual(TICKET_TYPES.map((type) => type.label), expected);
  const panel = publicPanel();
  const menu = panel.components[0].toJSON().components[0];
  assert.deepEqual(menu.options.map((option) => option.label), expected);
  assert.equal(menu.min_values, 1);
  assert.equal(menu.max_values, 1);
  assert.equal(new Set(menu.options.map((option) => option.value)).size, 6);
});

test('les noms de salons affichent le statut, le type et un numéro stable', () => {
  const ticket = record();
  assert.equal(channelName(ticket), '🔴-attente-plainte-elodie-0001');
  assert.equal(channelName({ ...ticket, status: 'claimed' }), '🟠-pris-en-charge-plainte-elodie-0001');
  assert.equal(channelName({ ...ticket, status: 'progress', progressDetail: 'Vérification des preuves' }), '🟡-en-cours-de-verification-des-preuves-plainte-elodie-0001');
  assert.equal(channelName({ ...ticket, status: 'resolved' }), '🟢-traite-plainte-elodie-0001');
  assert.equal(channelName({ ...ticket, status: 'closed' }), '⚫-ferme-plainte-elodie-0001');
  assert.equal(statusLabel({ ...ticket, status: 'progress', progressDetail: 'enquête' }), '🟡 En cours d’enquête');
  assert.equal(slugify(' Élodie / Test ! '), 'elodie-test');
  const long = channelName({ ...ticket, ownerName: 'x'.repeat(100), status: 'progress', progressDetail: 'a'.repeat(100) });
  assert.ok(long.length <= 100);
  assert.ok(long.endsWith('-0001'));
});

test('configuration JSON obligatoire, catégories précises et rôles spécifiques', () => {
  assert.throws(() => loadConfig({}, '/tmp'), /token/);
  assert.throws(() => loadConfig(configData({ serveurId: 'invalide' }), '/tmp'), /serveurId/);
  assert.throws(() => loadConfig(configData({ serveurId: Number(GUILD) }), '/tmp'), /entre guillemets/);
  assert.throws(() => loadConfig(configData({ rolesStaff: [GUILD] }), '/tmp'), /@everyone/);
  assert.throws(() => loadConfig(configData({ rolesStaffParCategorie: { plainte: [GUILD] } }), '/tmp'), /@everyone/);
  assert.throws(() => loadConfig(configData({ rolesStaffParCategorie: { plainte: null } }), '/tmp'), /liste/);
  assert.throws(() => loadConfig(configData({ rolesStaffParCategorie: { rcstaff: [ROLE] } }), '/tmp'), /Catégorie inconnue/);
  assert.throws(() => loadConfig(configData({ categories: { ...CATEGORIES, plainte: Number(PARENT) } }), '/tmp'), /entre guillemets/);
  for (const type of TICKET_TYPES) {
    const categories = { ...CATEGORIES, [type.key]: '' };
    assert.throws(() => loadConfig(configData({ categories }), '/tmp'), new RegExp(`categories\\.${type.key}`));
  }
  const config = loadConfig(configData({
    rolesStaff: [` ${ROLE} `, ROLE],
    rolesStaffParCategorie: { plainte: [], rc_staff: [SPECIAL_ROLE] },
  }), '/projet');
  assert.deepEqual(config.staffRolesByType.plainte, [ROLE]);
  assert.deepEqual(config.staffRolesByType.rc_staff, [SPECIAL_ROLE]);
  assert.deepEqual(config.categoryIdsByType, CATEGORIES);
  assert.equal(config.dataFile, '/projet/data/tickets.json');
});

test('config.json est lu sans exposer le token en cas de fichier absent ou invalide', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'config.json');
  assert.throws(() => loadConfigFile(file), /config\.example\.json/);
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(configData())}`);
  const config = loadConfigFile(file);
  assert.equal(config.guildId, GUILD);
  assert.equal(config.dataFile, path.join(dir, 'data', 'tickets.json'));
  assert.deepEqual(config.categoryIdsByType, CATEGORIES);
  const secret = 'un-token-confidentiel';
  fs.writeFileSync(file, `{"token":"${secret}",`);
  assert.throws(() => loadConfigFile(file), (error) => /syntaxe JSON/.test(error.message) && !error.message.includes(secret));
});

test('le modèle JSON expose les six catégories sans catégorie par défaut', () => {
  const template = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(template.categories), TICKET_TYPES.map((type) => type.key));
  assert.ok(Object.values(template.categories).every((value) => value === ''));
  assert.ok(!Object.hasOwn(template, 'categorieParDefaut'));
  assert.throws(() => loadConfig(template), /token/);
});

test('les permissions du salon excluent @everyone et distinguent rôles et membres', () => {
  const overwrites = ticketOverwrites(GUILD, BOT, OWNER, [ROLE]);
  assert.equal(overwrites.length, 4);
  const everyone = overwrites.find((item) => item.id === GUILD);
  assert.equal(everyone.type, 0);
  assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel));
  assert.equal(overwrites.find((item) => item.id === OWNER).type, 1);
  assert.equal(overwrites.find((item) => item.id === ROLE).type, 0);
  assert.equal(overwrites.find((item) => item.id === BOT).type, 1);
  // La résolution par discord.js doit aussi fonctionner si les membres ne sont pas en cache.
  assert.doesNotThrow(() => overwrites.map((item) => PermissionOverwrites.resolve(item)));
  assert.equal(Object.values(REQUIRED_BOT_PERMISSIONS).reduce((a, bit) => a | bit, 0n).toString(), '378225675280');
});

test('les commandes et les panneaux sont sérialisables pour Discord', () => {
  assert.equal(commands[0].toJSON().name, 'panneau-tickets');
  assert.equal(commands[0].toJSON().default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
  assert.equal(commands[2].toJSON().name, 'tickets');
  assert.deepEqual(commands[2].toJSON().options.map((option) => option.name), ['statut', 'categorie', 'responsable', 'mes_tickets']);
  const button = (panel, id) => panel.components.flatMap((row) => row.toJSON().components).find((item) => item.custom_id === id);
  const open = ticketPanel(record());
  assert.equal(open.embeds[0].toJSON().fields[1].value, '🔴 En attente');
  assert.equal(button(open, IDS.claim).disabled, false);
  assert.equal(button(open, IDS.waiting).disabled, false);
  assert.equal(button(open, IDS.reopen).disabled, true);
  const closed = ticketPanel({ ...record(), status: 'closed' });
  assert.equal(button(closed, IDS.claim).disabled, true);
  assert.equal(button(closed, IDS.waiting).disabled, true);
  assert.equal(button(closed, IDS.reopen).disabled, false);
});

test('le registre persiste, protège ses copies et ne mélange pas les serveurs', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'tickets.json');
  const store = new TicketStore(file, GUILD);
  assert.equal(store.allocateNumber(), 1);
  store.save(record());
  const copy = store.get(CHANNEL);
  copy.status = 'closed';
  assert.equal(store.get(CHANNEL).status, 'waiting');
  const reloaded = new TicketStore(file, GUILD);
  assert.equal(reloaded.findOpen(OWNER, 'plainte').channelId, CHANNEL);
  assert.equal(reloaded.allocateNumber(), 2);
  reloaded.markDeleted(CHANNEL);
  assert.equal(reloaded.findOpen(OWNER, 'plainte'), null);
  assert.equal(reloaded.get(CHANNEL).status, 'deleted');
  assert.throws(() => new TicketStore(file, OTHER_GUILD), /autre serveur/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tickets.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('un registre corrompu bloque le démarrage sans être écrasé', (t) => {
  const file = path.join(tempDir(t), 'tickets.json');
  fs.writeFileSync(file, 'pas du JSON');
  assert.throws(() => new TicketStore(file, GUILD), /Impossible de lire/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'pas du JSON');
});

test('le verrou sérialise la même clé et se libère après une erreur', async () => {
  const lock = new KeyedLock();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = lock.run('même clé', async () => { events.push('premier'); await gate; throw new Error('échec'); });
  const second = lock.run('même clé', () => { events.push('deuxième'); });
  const other = lock.run('autre clé', () => { events.push('autre'); });
  await other;
  assert.deepEqual(events, ['premier', 'autre']);
  release();
  await assert.rejects(first, /échec/);
  await second;
  assert.deepEqual(events, ['premier', 'autre', 'deuxième']);
});

test('le registre refuse les doublons actifs et les états altérés', (t) => {
  const file = path.join(tempDir(t), 'tickets.json');
  const store = new TicketStore(file, GUILD);
  store.allocateNumber();
  store.save(record());
  store.allocateNumber();
  assert.throws(() => store.save({ ...record(2), channelId: '500000000000000002' }), /déjà ouvert/);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  persisted.tickets[CHANNEL].status = 'toString';
  fs.writeFileSync(file, JSON.stringify(persisted));
  assert.throws(() => new TicketStore(file, GUILD), /tickets invalides/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tickets[CHANNEL].status, 'toString');
});

test('les vérifications de serveur détectent les rôles, catégories et permissions incorrects', async () => {
  const config = loadConfig(configData(), '/tmp');
  const checkedCategories = [];
  const fake = {
    id: GUILD,
    members: { fetchMe: async () => ({ permissions: new PermissionsBitField(Object.values(REQUIRED_BOT_PERMISSIONS)) }) },
    roles: { fetch: async (id) => id === ROLE ? { id } : null },
    channels: { fetch: async (id) => { checkedCategories.push(id); return { id, guildId: GUILD, type: ChannelType.GuildCategory }; } },
  };
  await assert.doesNotReject(validateGuildConfiguration(fake, config));
  assert.deepEqual(new Set(checkedCategories), new Set(Object.values(CATEGORIES)));
  await assert.rejects(validateGuildConfiguration(fake, {
    ...config, categoryIdsByType: { ...config.categoryIdsByType, question: null },
  }), /ID de catégorie manquant pour Question/);
  fake.members.fetchMe = async () => ({ permissions: new PermissionsBitField() });
  await assert.rejects(validateGuildConfiguration(fake, config), /Gérer les salons/);
  fake.members.fetchMe = async () => ({ permissions: new PermissionsBitField(Object.values(REQUIRED_BOT_PERMISSIONS)) });
  fake.roles.fetch = async () => null;
  await assert.rejects(validateGuildConfiguration(fake, config), /Rôle staff introuvable/);
  fake.roles.fetch = async (id) => ({ id });
  fake.channels.fetch = async () => ({ guildId: GUILD, type: ChannelType.GuildText });
  await assert.rejects(validateGuildConfiguration(fake, config), /n’est pas une catégorie/);
  fake.channels.fetch = async () => { throw Object.assign(new Error('inconnu'), { code: 10003 }); };
  await assert.rejects(validateGuildConfiguration(fake, config), /catégorie Discord.*introuvable/);
});

test('l’enregistrement des commandes ne supprime pas les autres commandes du bot', async () => {
  const existing = new Collection([
    ['1', { id: '1', name: 'panneau-tickets', type: ApplicationCommandType.ChatInput }],
    ['2', { id: '2', name: 'autre-commande', type: ApplicationCommandType.ChatInput }],
  ]);
  const edited = [];
  const created = [];
  const guild = { commands: {
    fetch: async () => existing,
    edit: async (id, command) => edited.push([id, command.toJSON().name]),
    create: async (command) => created.push(command.toJSON().name),
  } };
  await registerGuildCommands(guild, commands);
  assert.deepEqual(edited, [['1', 'panneau-tickets']]);
  assert.deepEqual(created, ['ticket-panneau', 'tickets']);
  assert.equal(existing.get('2').name, 'autre-commande');
});

test('seuls les rate limits de modification de salon sont transmis au synchroniseur', () => {
  assert.equal(rejectChannelRenameRateLimit({ route: '/channels/:id', method: 'PATCH' }), true);
  assert.equal(rejectChannelRenameRateLimit({ route: '/channels/:id', method: 'GET' }), false);
  assert.equal(rejectChannelRenameRateLimit({ route: '/channels/:id/permissions/:id', method: 'PUT' }), false);
});

test('discord.js renvoie le vrai délai d’un 429 de renommage sans attendre', async () => {
  let requests = 0;
  const rest = new REST({
    rejectOnRateLimit: rejectChannelRenameRateLimit,
    offset: 0,
    retries: 0,
    hashSweepInterval: 0,
    handlerSweepInterval: 0,
    makeRequest: async () => {
      requests++;
      return new Response(JSON.stringify({ message: 'rate limited', retry_after: 0.2, global: false }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0.2', 'x-ratelimit-scope': 'shared' },
      });
    },
  }).setToken('token-de-test');
  await assert.rejects(
    rest.patch('/channels/100000000000000001', { body: { name: 'test' } }),
    (error) => error instanceof RateLimitError && error.retryAfter === 200 && error.route === '/channels/:id',
  );
  assert.equal(requests, 1);
});

test('les index suivent fermeture, suppression et réouverture sans céder après un échec disque', (t) => {
  const file = path.join(tempDir(t), 'tickets.json');
  const store = new TicketStore(file, GUILD);
  const first = record(store.allocateNumber());
  store.save(first);
  const second = { ...record(store.allocateNumber()), channelId: '500000000000000002' };
  const closed = {
    ...first, status: 'closed', closedAt: '2026-01-02T12:00:00.000Z',
    closedPermissions: { SendMessages: true, SendMessagesInThreads: null, CreatePublicThreads: null, CreatePrivateThreads: null },
  };

  const before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('disque plein'); };
    assert.throws(() => store.save(closed), /disque plein/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(store.findOpen(OWNER, 'plainte').channelId, first.channelId);
  assert.throws(() => store.save(second), /déjà ouvert/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tickets.json']);

  store.save(closed);
  assert.equal(store.findOpen(OWNER, 'plainte'), null);
  store.save(second);
  assert.throws(() => store.save(first), /déjà ouvert/);
  assert.throws(() => store.save({ ...second, channelId: '500000000000000003', ownerId: '400000000000000003' }), /numéro.*déjà utilisé/);
  store.markDeleted(second.channelId);
  store.save(first);
  assert.equal(store.findOpen(OWNER, 'plainte').channelId, first.channelId);

  const listCopy = store.list();
  listCopy.find((ticket) => ticket.channelId === first.channelId).staffRoleIds.push('200000000000000099');
  assert.deepEqual(store.get(first.channelId).staffRoleIds, [ROLE]);
  const reloaded = new TicketStore(file, GUILD);
  assert.equal(reloaded.findOpen(OWNER, 'plainte').channelId, first.channelId);
  assert.throws(() => reloaded.save({ ...second, status: 'waiting', deletedAt: null }), /déjà ouvert/);
});

test('les limites de salons sont reconnues sur les erreurs réelles de discord.js', () => {
  const raw = {
    code: 50035, message: 'Invalid Form Body',
    errors: { parent_id: { _errors: [{ code: 'CHANNEL_PARENT_MAX_CHANNELS', message: 'Maximum number of channels in category reached (50)' }] } },
  };
  const full = new DiscordAPIError(raw, 50035, 400, 'POST', '/guilds/1/channels', {});
  assert.equal(isFullCategory(full), true);
  assert.equal(isServerChannelLimit(full), false);
  const other = new DiscordAPIError({ ...raw, errors: { parent_id: { _errors: [{ code: 'OTHER' }] } } }, 50035, 400, 'POST', '/guilds/1/channels', {});
  assert.equal(isFullCategory(other), false);
  assert.equal(isServerChannelLimit(new DiscordAPIError({ code: 30013, message: 'Maximum channels' }, 30013, 400, 'POST', '/guilds/1/channels', {})), true);
});

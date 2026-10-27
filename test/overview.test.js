import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Client, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { TICKET_TYPES } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { createInteractionHandler } from '../src/interactions.js';
import { parseOverviewButton } from '../src/overview.js';

const GUILD = '100000000000000001';
const ROLE = '200000000000000001';
const SPECIAL = '200000000000000002';
const ADMIN_ROLE = '200000000000000003';
const STAFF = '300000000000000001';
const SPECIAL_STAFF = '300000000000000002';
const ADMIN = '300000000000000003';
const OUTSIDER = '300000000000000004';
const CATEGORY = '400000000000000001';
const MESSAGE = '900000000000000001';
const VIEW = String(PermissionFlagsBits.ViewChannel);
const logger = { error() {} };

function role(id, name, permissions = '0') {
  return { id, name, permissions, position: 1, color: 0, hoist: false, managed: false, mentionable: false };
}

function member(id, roles = []) {
  return { user: { id, username: `user-${id}`, discriminator: '0' }, roles, joined_at: '2025-01-01T00:00:00.000Z' };
}

function ticket(number, options = {}) {
  const timestamp = options.updatedAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString();
  return {
    channelId: String(500000000000000000n + BigInt(number)),
    ownerId: String(600000000000000000n + BigInt(number)),
    number, type: options.type ?? 'plainte', status: options.status ?? 'waiting',
    ownerName: `Membre ${number}`, progressDetail: options.progressDetail ?? null,
    assignedTo: options.assignedTo ?? null, staffRoleIds: [ROLE], panelMessageId: null,
    createdAt: timestamp, updatedAt: timestamp, closedAt: null, closedPermissions: null, deletedAt: null,
  };
}

function makeHarness(t) {
  // De vrais objets discord.js calculent les permissions ; seule l'API HTTP est simulée.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  t.after(() => client.destroy());
  const roles = [role(GUILD, '@everyone'), role(ROLE, 'Staff'), role(SPECIAL, 'RC STAFF'), role(ADMIN_ROLE, 'Admin', String(PermissionFlagsBits.Administrator))];
  const guild = client.guilds._add({ id: GUILD, name: 'Madrid RP', owner_id: '800000000000000001', roles, channels: [] });
  const api = {
    roles, channels: [], requests: [], fail: null, hook: null,
    members: new Map([
      [STAFF, member(STAFF, [ROLE])], [SPECIAL_STAFF, member(SPECIAL_STAFF, [SPECIAL])],
      [ADMIN, member(ADMIN, [ADMIN_ROLE])], [OUTSIDER, member(OUTSIDER)],
    ]),
  };
  client.rest.get = async (route) => {
    api.requests.push(route);
    if (api.hook) await api.hook(route);
    if (api.fail && route.includes(api.fail)) throw new Error('API Discord indisponible');
    if (route === `/guilds/${GUILD}/roles`) return structuredClone(api.roles);
    if (route === `/guilds/${GUILD}/channels`) return structuredClone(api.channels);
    const prefix = `/guilds/${GUILD}/members/`;
    if (route.startsWith(prefix) && api.members.has(route.slice(prefix.length))) return structuredClone(api.members.get(route.slice(prefix.length)));
    throw new Error(`Requête inattendue : ${route}`);
  };
  const categories = Object.fromEntries(TICKET_TYPES.map(({ key }, index) => [key, String(BigInt(CATEGORY) + BigInt(index))]));
  const config = loadConfig({
    token: 'token-test', serveurId: GUILD, rolesStaff: [ROLE], categories,
    rolesStaffParCategorie: { rc_staff: [SPECIAL] },
  });
  const store = { records: [], list() { return structuredClone(this.records); } };
  const handle = createInteractionHandler({ config, service: { store }, logger });
  function add(entry, { denyMember = null, extraRoles = [], missing = false } = {}) {
    store.records.push(entry);
    if (missing) return;
    const permittedRole = entry.type === 'rc_staff' ? SPECIAL : ROLE;
    const permission_overwrites = [
      { id: GUILD, type: 0, allow: '0', deny: VIEW },
      ...[...new Set([permittedRole, ...extraRoles])].map((id) => ({ id, type: 0, allow: VIEW, deny: '0' })),
    ];
    if (denyMember) permission_overwrites.push({ id: denyMember, type: 1, allow: '0', deny: VIEW });
    api.channels.push({ id: entry.channelId, guild_id: GUILD, parent_id: categories[entry.type], name: `ticket-${entry.number}`, type: ChannelType.GuildText, permission_overwrites });
  }
  return { api, guild, store, handle, add };
}

function interaction(h, { userId = STAFF, command = true, customId = null, options = {}, shared = null, guildId = GUILD } = {}) {
  const item = {
    guild: h.guild, guildId, user: { id: userId }, commandName: 'tickets', customId,
    message: { id: MESSAGE }, member: null, memberPermissions: null,
    options: {
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getUser: (name) => options[name] ? { id: options[name] } : null,
    },
    deferred: false, replied: false, response: shared, events: [],
    isChatInputCommand: () => command,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isButton: () => !command,
    async deferReply(payload) { this.deferred = true; this.deferOptions = payload; this.events.push('déféré'); },
    async deferUpdate() { this.deferred = true; this.events.push('déféré'); },
    async reply(payload) { this.replied = true; this.response = payload; this.events.push('réponse'); },
    async editReply(payload) {
      this.response = { ...this.response, ...payload };
      if (shared) Object.assign(shared, payload);
      this.events.push('modification');
    },
  };
  return item;
}

const description = (item) => item.response.embeds[0].toJSON().description;
const buttons = (item) => item.response.components[0].toJSON().components;
const mentionedChannels = (item) => [...description(item).matchAll(/<#(\d+)>/g)].map((match) => match[1]);

async function runCommand(h, options = {}) {
  const item = interaction(h, options);
  await h.handle(item);
  return item;
}

async function click(h, customId, options = {}) {
  const item = interaction(h, { ...options, command: false, customId });
  await h.handle(item);
  return item;
}

test('la vue filtre les rôles par catégorie et les permissions effectives, y compris les comptes', async (t) => {
  const h = makeHarness(t);
  const visible = ticket(1);
  const denied = ticket(2);
  const sensitive = ticket(3, { type: 'rc_staff' });
  const missing = ticket(4, { type: 'question' });
  const deleted = ticket(5, { status: 'deleted' });
  const closed = ticket(6, { status: 'closed' });
  // Un accès manuel au salon ne remplace pas le rôle autorisé pour le type.
  h.add(visible, { extraRoles: [SPECIAL] });
  h.add(denied, { denyMember: STAFF });
  // Même si un rôle général a accès au salon, il ne gère pas le type RC STAFF.
  h.add(sensitive, { extraRoles: [ROLE] });
  h.add(missing, { missing: true });
  h.add(deleted);
  h.add(closed);

  const staff = await runCommand(h);
  assert.equal(staff.deferred, true);
  assert.equal(staff.deferOptions.flags, MessageFlags.Ephemeral);
  assert.deepEqual(mentionedChannels(staff), [visible.channelId]);
  assert.match(description(staff), /🔴 1 · 🟠 0 · 🟡 0 · 🟢 0 · ⚫ 1/);
  assert.match(description(staff), /Résultats :\*\* 1/);
  for (const secret of [denied, sensitive, missing, deleted, closed]) assert.ok(!description(staff).includes(secret.channelId));
  assert.deepEqual(staff.response.allowedMentions, { parse: [] });

  const restricted = await runCommand(h, { options: { statut: 'all', categorie: 'rc_staff' } });
  assert.deepEqual(mentionedChannels(restricted), []);
  assert.match(description(restricted), /🔴 0 · 🟠 0 · 🟡 0 · 🟢 0 · ⚫ 0/);
  const rc = await runCommand(h, { userId: SPECIAL_STAFF, options: { statut: 'all' } });
  assert.deepEqual(mentionedChannels(rc), [sensitive.channelId]);
  assert.match(description(rc), /🔴 1 · 🟠 0 · 🟡 0 · 🟢 0 · ⚫ 0/);
  const admin = await runCommand(h, { userId: ADMIN, options: { statut: 'all' } });
  assert.deepEqual(new Set(mentionedChannels(admin)), new Set([visible.channelId, denied.channelId, sensitive.channelId, closed.channelId]));
});

test('un membre non autorisé ne reçoit aucun résultat ni compteur et aucun salon n’est chargé', async (t) => {
  const h = makeHarness(t);
  h.add(ticket(1));
  const outsider = await runCommand(h, { userId: OUTSIDER });
  assert.equal(outsider.deferOptions.flags, MessageFlags.Ephemeral);
  assert.match(outsider.response.content, /Seule l’équipe/);
  assert.deepEqual(outsider.response.embeds, []);
  assert.ok(!h.api.requests.some((route) => route.endsWith('/channels')));
  assert.ok(!JSON.stringify(outsider.response).includes('500000000000000001'));
});

test('pagination, tri des attentes les plus anciennes et identifiants de boutons valides', async (t) => {
  const h = makeHarness(t);
  for (let n = 1; n <= 20; n++) {
    h.add(ticket(n, { updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 21 - n)).toISOString() }));
  }
  h.add(ticket(21, { status: 'resolved', updatedAt: '2025-01-01T00:00:00.000Z' }));
  const first = await runCommand(h);
  assert.deepEqual(mentionedChannels(first), Array.from({ length: 8 }, (_, i) => ticket(20 - i).channelId));
  assert.match(first.response.embeds[0].toJSON().footer.text, /Page 1\/3/);
  assert.equal(buttons(first)[0].disabled, true);
  assert.equal(buttons(first)[2].disabled, false);
  const ids = buttons(first).map((button) => button.custom_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.length <= 100));
  assert.equal(parseOverviewButton(ids[2]).query.page, 1);

  const second = await click(h, ids[2]);
  assert.deepEqual(mentionedChannels(second), Array.from({ length: 8 }, (_, i) => ticket(12 - i).channelId));
  const third = await click(h, buttons(second)[2].custom_id);
  assert.deepEqual(mentionedChannels(third), [ticket(4).channelId, ticket(3).channelId, ticket(2).channelId, ticket(1).channelId, ticket(21).channelId]);
  assert.equal(buttons(third)[2].disabled, true);
  assert.equal(new Set(buttons(third).map((button) => button.custom_id)).size, 3);

  const staleRefresh = buttons(third)[1].custom_id;
  h.store.records = [h.store.records[0]];
  const refreshed = await click(h, staleRefresh);
  assert.match(refreshed.response.embeds[0].toJSON().footer.text, /Page 1\/1/);
  assert.deepEqual(mentionedChannels(refreshed), [ticket(1).channelId]);
  assert.equal(new Set(buttons(refreshed).map((button) => button.custom_id)).size, 3);
});

test('les filtres statut, catégorie et responsable sont combinés sans compter les autres catégories', async (t) => {
  const h = makeHarness(t);
  h.add(ticket(1, { type: 'question', status: 'claimed', assignedTo: STAFF }));
  h.add(ticket(2, { type: 'question', status: 'claimed', assignedTo: SPECIAL_STAFF }));
  h.add(ticket(3, { type: 'question', status: 'progress', assignedTo: STAFF, progressDetail: 'enquête *privée*' }));
  h.add(ticket(4, { type: 'plainte', status: 'claimed', assignedTo: STAFF }));
  const result = await runCommand(h, { options: { statut: 'claimed', categorie: 'question', mes_tickets: true } });
  assert.deepEqual(mentionedChannels(result), [ticket(1).channelId]);
  assert.match(description(result), /🟠 1 · 🟡 1/);
  assert.match(description(result), /attribués à vous/);
  const progress = await runCommand(h, { options: { statut: 'progress', categorie: 'question', mes_tickets: true } });
  assert.deepEqual(mentionedChannels(progress), [ticket(3).channelId]);
  assert.match(description(progress), /\\\*privée\\\*/);
  const colleague = await runCommand(h, { options: { statut: 'claimed', categorie: 'question', responsable: SPECIAL_STAFF } });
  assert.deepEqual(mentionedChannels(colleague), [ticket(2).channelId]);
  assert.match(description(colleague), new RegExp(`responsable : <@${SPECIAL_STAFF}>`));
  const colleagueRefreshed = await click(h, buttons(colleague)[1].custom_id);
  assert.deepEqual(mentionedChannels(colleagueRefreshed), [ticket(2).channelId]);
  const conflict = await runCommand(h, { options: { responsable: SPECIAL_STAFF, mes_tickets: true } });
  assert.match(conflict.response.content, /pas les deux/);
});

test('chaque clic recontrôle le salon, les rôles et le propriétaire de la vue', async (t) => {
  const h = makeHarness(t);
  const item = ticket(1);
  h.add(item);
  const first = await runCommand(h);
  const refreshId = buttons(first)[1].custom_id;
  const before = h.api.requests.length;
  const other = await click(h, refreshId, { userId: SPECIAL_STAFF });
  assert.match(other.response.content, /tableau est personnel/);
  assert.equal(other.response.flags, MessageFlags.Ephemeral);
  assert.equal(h.api.requests.length, before);

  h.api.channels[0].permission_overwrites.push({ id: STAFF, type: 1, allow: '0', deny: VIEW });
  const hidden = await click(h, refreshId);
  assert.deepEqual(mentionedChannels(hidden), []);
  assert.match(description(hidden), /🔴 0/);
  assert.ok(!description(hidden).includes(item.channelId));

  h.api.members.get(STAFF).roles = [];
  const revoked = await click(h, refreshId, { shared: { ...first.response } });
  assert.match(revoked.response.content, /Seule l’équipe/);
  assert.deepEqual(revoked.response.embeds, []);
  assert.deepEqual(revoked.response.components, []);
});

test('une erreur de vérification efface l’ancienne vue et les interactions sont acquittées avant les requêtes', async (t) => {
  const h = makeHarness(t);
  h.add(ticket(1));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.api.hook = async () => { await gate; };
  const first = interaction(h);
  const pending = h.handle(first);
  assert.equal(first.deferred, true);
  assert.equal(first.deferOptions.flags, MessageFlags.Ephemeral);
  release();
  await pending;
  h.api.hook = null;
  h.api.fail = '/channels';
  const refresh = await click(h, buttons(first)[1].custom_id, { shared: { ...first.response } });
  assert.equal(refresh.deferred, true);
  assert.match(refresh.response.content, /Une erreur est survenue/);
  assert.deepEqual(refresh.response.embeds, []);
  assert.deepEqual(refresh.response.components, []);
});

test('deux clics concurrents ne réaffichent pas une vue périmée après retrait d’un rôle', async (t) => {
  const h = makeHarness(t);
  h.add(ticket(1));
  const first = await runCommand(h);
  const refreshId = buttons(first)[1].custom_id;
  h.api.requests.length = 0;
  let release;
  let signal;
  let blocked = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { signal = resolve; });
  h.api.hook = async (route) => {
    if (!blocked && route.endsWith('/channels')) {
      blocked = true;
      signal();
      await gate;
    }
  };
  const shared = { ...first.response };
  const older = interaction(h, { command: false, customId: refreshId, shared });
  const newer = interaction(h, { command: false, customId: refreshId, shared });
  const firstClick = h.handle(older);
  await started;
  h.api.members.get(STAFF).roles = [];
  const secondClick = h.handle(newer);
  await Promise.resolve();
  assert.equal(newer.deferred, true);
  assert.equal(h.api.requests.filter((route) => route.endsWith('/roles')).length, 1);
  release();
  await Promise.all([firstClick, secondClick]);
  assert.match(shared.content, /Seule l’équipe/);
  assert.deepEqual(shared.embeds, []);
  assert.deepEqual(shared.components, []);
  assert.equal(h.api.requests.filter((route) => route.endsWith('/roles')).length, 2);
});

test('la vue parcourt plusieurs dizaines de tickets sans requête Discord par ticket', async (t) => {
  const h = makeHarness(t);
  const types = ['plainte', 'question', 'demande_unban', 'fondation', 'partenariat'];
  for (let n = 1; n <= 73; n++) h.add(ticket(n, { type: types[(n - 1) % types.length] }));
  let page = await runCommand(h, { options: { statut: 'waiting' } });
  const seen = [];
  for (;;) {
    seen.push(...mentionedChannels(page));
    const controls = buttons(page);
    assert.equal(new Set(controls.map((button) => button.custom_id)).size, 3);
    if (controls[2].disabled) break;
    page = await click(h, controls[2].custom_id);
  }
  assert.equal(seen.length, 73);
  assert.equal(new Set(seen).size, 73);
  // 10 pages × (rôles + membre + liste des salons), indépendamment du nombre de tickets.
  assert.equal(h.api.requests.length, 30);
  assert.equal(h.api.requests.filter((route) => route.endsWith('/channels')).length, 10);
});

test('filtres et boutons invalides sont rejetés sans fuite et un autre serveur est ignoré', async (t) => {
  const h = makeHarness(t);
  h.add(ticket(1));
  const invalidStatus = await runCommand(h, { options: { statut: 'toString' } });
  assert.match(invalidStatus.response.content, /filtres ne sont plus valides/);
  assert.equal(invalidStatus.response.flags, MessageFlags.Ephemeral);
  assert.equal(h.api.requests.length, 0);

  const invalidButton = await click(h, `tickets:overview:${STAFF}:active:toString:all:0:r`);
  assert.match(invalidButton.response.content, /filtres ne sont plus valides/);
  assert.equal(invalidButton.response.flags, MessageFlags.Ephemeral);
  assert.equal(h.api.requests.length, 0);

  const foreign = await runCommand(h, { guildId: '100000000000000002' });
  assert.equal(foreign.response, null);
  assert.equal(h.api.requests.length, 0);
});

test('les filtres restent sérialisables avec des identifiants Discord de 20 chiffres', async (t) => {
  const h = makeHarness(t);
  const viewer = '18446744073709551615';
  const assignee = '18446744073709551614';
  h.api.members.set(viewer, member(viewer, [ROLE]));
  h.add(ticket(1, { type: 'demande_unban', status: 'progress', progressDetail: '*'.repeat(39) + 'a', assignedTo: assignee }));
  const item = await runCommand(h, { userId: viewer, options: { statut: 'progress', categorie: 'demande_unban', responsable: assignee } });
  assert.deepEqual(mentionedChannels(item), [ticket(1).channelId]);
  assert.ok(description(item).length < 4096);
  const controls = buttons(item);
  assert.ok(controls.every((control) => control.custom_id.length <= 100));
  assert.equal(parseOverviewButton(controls[1].custom_id).query.assignee, assignee);
  const refreshed = await click(h, controls[1].custom_id, { userId: viewer });
  assert.deepEqual(mentionedChannels(refreshed), [ticket(1).channelId]);
});

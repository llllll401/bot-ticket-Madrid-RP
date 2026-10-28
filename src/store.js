import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { slugify, STATUSES, TYPE_BY_KEY } from './catalog.js';
import { MAX_INTERNAL_NOTES, MAX_INTERNAL_NOTE_LENGTH } from './dossier.js';
import { OWNER_WRITE_PERMISSIONS } from './permissions.js';

const SNOWFLAKE = /^\d{17,20}$/;
const isId = (value) => typeof value === 'string' && SNOWFLAKE.test(value);
const isOptionalId = (value) => value === null || isId(value);
const isDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isOptionalDate = (value) => value === null || isDate(value);
const isClosedWrites = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && OWNER_WRITE_PERMISSIONS.every((name) => [true, false, null].includes(value[name]));
const isOpen = (ticket) => !['closed', 'deleted'].includes(ticket.status);
const slot = (ticket) => `${ticket.ownerId}:${ticket.type}`;
const activeSlotsForTicket = (ticket) => !isOpen(ticket) ? [] : [
  slot(ticket),
  ...(ticket.pendingReclassification ? [`${ticket.ownerId}:${ticket.pendingReclassification.targetType}`] : []),
];
const isInternalNote = (note) => note && typeof note === 'object' && !Array.isArray(note)
  && isId(note.authorId) && isDate(note.createdAt) && typeof note.text === 'string'
  && Boolean(note.text.trim()) && note.text.length <= MAX_INTERNAL_NOTE_LENGTH;

function validTicket(ticket, channelId, guildId) {
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)
    || !isId(channelId) || ticket.channelId !== channelId
    || !Number.isSafeInteger(ticket.number) || ticket.number < 1
    || !isId(ticket.ownerId) || typeof ticket.ownerName !== 'string' || !ticket.ownerName
    || !Object.hasOwn(TYPE_BY_KEY, ticket.type) || !Object.hasOwn(STATUSES, ticket.status)
    || !Array.isArray(ticket.staffRoleIds) || !ticket.staffRoleIds.length
    || ticket.staffRoleIds.some((role) => !isId(role) || role === guildId)
    || new Set(ticket.staffRoleIds).size !== ticket.staffRoleIds.length
    || (ticket.roleSyncPending != null && (!Array.isArray(ticket.roleSyncPending)
      || ticket.roleSyncPending.some((role) => !isId(role) || role === guildId)
      || new Set(ticket.roleSyncPending).size !== ticket.roleSyncPending.length))
    || (ticket.renamePending != null && typeof ticket.renamePending !== 'boolean')
    || (ticket.urgent != null && typeof ticket.urgent !== 'boolean')
    || (ticket.assignmentRevision != null && (!Number.isSafeInteger(ticket.assignmentRevision) || ticket.assignmentRevision < 0))
    || (ticket.categoryRevision != null && (!Number.isSafeInteger(ticket.categoryRevision) || ticket.categoryRevision < 0))
    || (ticket.internalNotes != null && (!Array.isArray(ticket.internalNotes)
      || ticket.internalNotes.length > MAX_INTERNAL_NOTES || !ticket.internalNotes.every(isInternalNote)))
    || (ticket.pendingReclassification != null && (typeof ticket.pendingReclassification !== 'object'
      || Array.isArray(ticket.pendingReclassification) || !isOpen(ticket)
      || !Object.hasOwn(TYPE_BY_KEY, ticket.pendingReclassification.targetType)
      || ticket.pendingReclassification.targetType === ticket.type
      || !isId(ticket.pendingReclassification.actorId) || !isDate(ticket.pendingReclassification.requestedAt)
      || !Array.isArray(ticket.pendingReclassification.candidateRoleIds)
      || !ticket.pendingReclassification.candidateRoleIds.length
      || ticket.pendingReclassification.candidateRoleIds.some((role) => !isId(role) || role === guildId)
      || new Set(ticket.pendingReclassification.candidateRoleIds).size !== ticket.pendingReclassification.candidateRoleIds.length))
    || (ticket.panelVersion != null && (!Number.isSafeInteger(ticket.panelVersion) || ticket.panelVersion < 1))
    || (ticket.closedBy != null && !isId(ticket.closedBy))
    || (ticket.deletedBy != null && !isId(ticket.deletedBy))
    || (ticket.deletionRequestedAt != null && !isDate(ticket.deletionRequestedAt))
    || (ticket.pendingDeletion != null && (typeof ticket.pendingDeletion !== 'object'
      || Array.isArray(ticket.pendingDeletion) || !isId(ticket.pendingDeletion.actorId)
      || !isDate(ticket.pendingDeletion.requestedAt) || ticket.status === 'deleted'))
    || !isOptionalId(ticket.assignedTo) || !isOptionalId(ticket.panelMessageId)
    || !isDate(ticket.createdAt) || !isDate(ticket.updatedAt)
    || !isOptionalDate(ticket.closedAt) || !isOptionalDate(ticket.deletedAt)
    || (ticket.closedPermissions !== null && !isClosedWrites(ticket.closedPermissions))
    || (ticket.pendingTransition != null && (typeof ticket.pendingTransition !== 'object'
      || Array.isArray(ticket.pendingTransition) || (ticket.pendingTransition.ownerWrites !== null
        && !isClosedWrites(ticket.pendingTransition.ownerWrites))))
    || (ticket.progressDetail !== null && (typeof ticket.progressDetail !== 'string' || ticket.progressDetail.length > 40))) {
    return false;
  }
  if (ticket.status === 'progress' && (!ticket.progressDetail || !slugify(ticket.progressDetail))) return false;
  if (ticket.status === 'closed' && (!isDate(ticket.closedAt) || !isClosedWrites(ticket.closedPermissions))) return false;
  if (ticket.status === 'deleted' && ticket.internalNotes?.length) return false;
  if (ticket.status !== 'deleted' && (ticket.deletedBy != null || ticket.deletionRequestedAt != null)) return false;
  if (!['closed', 'deleted'].includes(ticket.status)
    && (ticket.closedAt !== null || ticket.closedBy != null || ticket.closedPermissions !== null || ticket.deletedAt !== null)) return false;
  return true;
}

function validateData(data, guildId) {
  if (!data || data.version !== 1 || !isId(data.guildId)
    || !Number.isSafeInteger(data.nextNumber) || data.nextNumber < 1
    || !data.tickets || typeof data.tickets !== 'object' || Array.isArray(data.tickets)) {
    throw new Error('Format du fichier de tickets invalide.');
  }
  if (data.guildId !== guildId) {
    throw new Error('Ce fichier de tickets appartient à un autre serveur. Utilisez un fichier de données distinct.');
  }
  const numbers = new Map();
  const activeSlots = new Map();
  for (const [channelId, ticket] of Object.entries(data.tickets)) {
    if (!validTicket(ticket, channelId, guildId) || ticket.number >= data.nextNumber || numbers.has(ticket.number)) {
      throw new Error('Le fichier contient des tickets invalides.');
    }
    numbers.set(ticket.number, channelId);
    for (const key of activeSlotsForTicket(ticket)) {
      if (activeSlots.has(key)) throw new Error('Le fichier contient plusieurs tickets ouverts pour un même membre et type.');
      activeSlots.set(key, channelId);
    }
  }
  return { numbers, activeSlots };
}

export class TicketStore {
  #file;
  #data;
  #numbers = new Map();
  #activeSlots = new Map();

  constructor(file, guildId) {
    this.#file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      try {
        this.#data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const indexes = validateData(this.#data, guildId);
        this.#numbers = indexes.numbers;
        this.#activeSlots = indexes.activeSlots;
      } catch (error) {
        throw new Error(`Impossible de lire ${file} : ${error.message}`, { cause: error });
      }
    } else {
      this.#data = { version: 1, guildId, nextNumber: 1, tickets: {} };
      this.#persist(this.#data);
    }
  }

  #persist(data) {
    const temporaryFile = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporaryFile, this.#file);
    } catch (error) {
      try { fs.unlinkSync(temporaryFile); } catch { /* Le fichier temporaire n'existe peut-être pas. */ }
      throw error;
    }
  }

  #commit(next) {
    this.#persist(next);
    this.#data = next;
  }

  allocateNumber() {
    if (this.#data.nextNumber >= Number.MAX_SAFE_INTEGER) throw new Error('Numérotation des tickets épuisée.');
    const number = this.#data.nextNumber;
    this.#commit({ ...this.#data, nextNumber: number + 1 });
    return number;
  }

  get(channelId) {
    if (!isId(channelId) || !Object.hasOwn(this.#data.tickets, channelId)) return null;
    return structuredClone(this.#data.tickets[channelId]);
  }

  list() {
    return Object.values(this.#data.tickets).map((ticket) => structuredClone(ticket));
  }

  findOpen(ownerId, type) {
    const channelId = this.#activeSlots.get(`${ownerId}:${type}`);
    return channelId ? this.get(channelId) : null;
  }

  save(ticket) {
    if (!validTicket(ticket, ticket?.channelId, this.#data.guildId) || ticket.number >= this.#data.nextNumber) {
      throw new Error('Impossible d’enregistrer un ticket invalide.');
    }
    const previous = this.#data.tickets[ticket.channelId];
    if (previous && (previous.number !== ticket.number || previous.ownerId !== ticket.ownerId)) {
      throw new Error('L’identité d’un ticket existant ne peut pas être modifiée.');
    }
    if (previous && previous.type !== ticket.type
      && (previous.pendingReclassification?.targetType !== ticket.type || ticket.pendingReclassification != null)) {
      throw new Error('Le type ne peut changer que par une reclassification préparée.');
    }
    const numberOwner = this.#numbers.get(ticket.number);
    if (numberOwner && numberOwner !== ticket.channelId) throw new Error('Ce numéro de ticket est déjà utilisé.');
    for (const key of activeSlotsForTicket(ticket)) {
      const activeOwner = this.#activeSlots.get(key);
      if (activeOwner && activeOwner !== ticket.channelId) {
        throw new Error('Un ticket est déjà ouvert pour ce membre et ce type.');
      }
    }
    // Les enregistrements internes ne sont jamais exposés sans copie. On ne recopie
    // donc que la table et le ticket modifié avant l'écriture atomique sur disque.
    const next = { ...this.#data, tickets: { ...this.#data.tickets, [ticket.channelId]: structuredClone(ticket) } };
    this.#commit(next);
    // Ne changer les index qu'après le succès de l'écriture : ils doivent toujours
    // refléter le fichier si un disque plein ou une erreur de permissions survient.
    if (previous) {
      for (const key of activeSlotsForTicket(previous)) {
        if (this.#activeSlots.get(key) === ticket.channelId) this.#activeSlots.delete(key);
      }
    }
    for (const key of activeSlotsForTicket(ticket)) this.#activeSlots.set(key, ticket.channelId);
    this.#numbers.set(ticket.number, ticket.channelId);
    return structuredClone(ticket);
  }

  markDeleted(channelId) {
    const ticket = this.get(channelId);
    if (!ticket || ticket.status === 'deleted') return ticket;
    const timestamp = new Date().toISOString();
    return this.save({
      ...ticket, status: 'deleted', deletedAt: timestamp, updatedAt: timestamp,
      closedAt: ticket.closedAt ?? ticket.pendingDeletion?.requestedAt ?? null,
      closedBy: ticket.closedBy ?? (ticket.status === 'closed' ? null : (ticket.pendingDeletion?.actorId ?? null)),
      deletedBy: ticket.pendingDeletion?.actorId ?? null,
      deletionRequestedAt: ticket.pendingDeletion?.requestedAt ?? null,
      // Les notes internes ne sont pas une transcription et ne survivent pas à
      // la suppression du ticket (les sauvegardes externes restent à gérer).
      internalNotes: [], pendingReclassification: null,
      pendingDeletion: null, pendingTransition: null, renamePending: false,
    });
  }
}

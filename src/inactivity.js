// Un rappel n'est jamais considéré comme une activité humaine.
export const INACTIVITY_WARNING_DELAY_MS = 2 * 60 * 60 * 1000;
export const INACTIVITY_DELETION_DELAY_MS = 2 * 60 * 60 * 1000;
export const INACTIVITY_RETRY_MS = 5 * 60 * 1000;
export const INACTIVITY_SCAN_MS = 60 * 1000;
export const INACTIVITY_REMINDER_GAP_MS = 3 * 1000;
export const INACTIVITY_TIME_ZONE = 'Europe/Paris';
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 10;
const AUTOMATION_START_MINUTES = 10 * 60 + 30;
const AUTOMATION_END_MINUTES = 20 * 60 + 30;
const parisClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: INACTIVITY_TIME_ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});

function parisMinutes(timestamp) {
  const parts = parisClockFormatter.formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => ['hour', 'minute'].includes(part.type)).map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

// Les actions automatiques sont limitées à la plage horaire du serveur Rennes RP,
// y compris lors des changements d’heure Europe/Paris.
export function isInactivityAutomationActive(timestamp = Date.now()) {
  if (!Number.isFinite(timestamp)) return false;
  const minutes = parisMinutes(timestamp);
  return minutes >= AUTOMATION_START_MINUTES && minutes < AUTOMATION_END_MINUTES;
}

function nextInactivityAutomationStartAt(timestamp) {
  const roundedMinute = Math.floor(timestamp / 60_000) * 60_000;
  // Parcourir des minutes UTC laisse Intl gérer correctement les heures d’été/hiver.
  for (let offset = 1; offset <= 26 * 60; offset++) {
    const candidate = roundedMinute + offset * 60_000;
    if (parisMinutes(candidate) === AUTOMATION_START_MINUTES) return candidate;
  }
  // Ne devrait jamais être atteint ; évite néanmoins une boucle agressive si Intl échoue.
  return timestamp + 60 * 60 * 1000;
}

export function inactivityDueAt(ticket) {
  if (!ticket || ['closed', 'deleted'].includes(ticket.status)
    || ticket.pendingDeletion || ticket.pendingTransition || ticket.pendingReclassification) return Infinity;
  const reminder = ticket.inactivityReminder;
  if (reminder?.state === 'sending') return Date.parse(reminder.attemptedAt) + INACTIVITY_RETRY_MS;
  if (reminder?.state === 'sent') return Date.parse(reminder.sentAt) + INACTIVITY_DELETION_DELAY_MS;
  return Date.parse(ticket.lastActivityAt ?? ticket.createdAt) + INACTIVITY_WARNING_DELAY_MS;
}

// Vérifie l'historique via REST avant chaque rappel ou suppression. Si la
// vérification est incomplète, on échoue plutôt que de supprimer à l'aveugle.
export async function latestHumanMessageSince(channel, sinceMs) {
  let before;
  for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex++) {
    const page = await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, cache: false, ...(before ? { before } : {}) });
    if (!page || typeof page.values !== 'function' || typeof page.size !== 'number') {
      throw new Error('Historique Discord incomplet ou invalide.');
    }
    if (page.size === 0) return null;
    let latest = null;
    let oldestId = null;
    let oldestTime = Infinity;
    for (const message of page.values()) {
      const timestamp = message?.createdTimestamp;
      if (!/^\d{17,20}$/.test(message?.id ?? '') || !Number.isFinite(timestamp)
        || !message.author || typeof message.author.bot !== 'boolean') {
        throw new Error('Un message Discord ne permet pas de vérifier l’inactivité.');
      }
      if (oldestId === null || BigInt(message.id) < BigInt(oldestId)) oldestId = message.id;
      oldestTime = Math.min(oldestTime, timestamp);
      if (timestamp > sinceMs && !message.author.bot && !message.webhookId
        && (!latest || timestamp > latest.createdTimestamp)) latest = message;
    }
    if (latest) return latest;
    if (page.size < HISTORY_PAGE_SIZE || oldestTime <= sinceMs) return null;
    if (oldestId === before) throw new Error('Pagination Discord invalide pendant la vérification d’inactivité.');
    before = oldestId;
  }
  throw new Error('Historique trop volumineux pour confirmer l’inactivité en sécurité.');
}

// Une boucle unique évite de lancer un traitement concurrent au même intervalle.
export class InactivityMonitor {
  constructor({ guild, service, logger = console, clock = Date.now, intervalMs = INACTIVITY_SCAN_MS }) {
    this.guild = guild;
    this.service = service;
    this.logger = logger;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.retryAfter = new Map();
    this.nextReminderAt = 0;
    this.timer = null;
    this.stopped = true;
    this.running = false;
    this.generation = 0;
  }

  async run() {
    if (this.running || this.stopped) return;
    const startedAt = this.clock();
    if (!isInactivityAutomationActive(startedAt) || this.nextReminderAt > startedAt) return;
    this.running = true;
    try {
      const tickets = this.service.store.list();
      const active = new Set(tickets.filter((ticket) => !['closed', 'deleted'].includes(ticket.status)).map((ticket) => ticket.channelId));
      for (const id of this.retryAfter.keys()) if (!active.has(id)) this.retryAfter.delete(id);
      for (const ticket of tickets) {
        const currentTime = this.clock();
        if (this.stopped || this.service.stopped || !isInactivityAutomationActive(currentTime)) break;
        if (inactivityDueAt(ticket) > currentTime || (this.retryAfter.get(ticket.channelId) ?? 0) > currentTime) continue;
        try {
          const result = await this.service.checkInactivity(this.guild, ticket.channelId);
          this.retryAfter.delete(ticket.channelId);
          // À la réouverture de la plage horaire, les tickets peuvent tous être
          // dus. Échelonner les messages évite de mentionner tous les membres
          // d’un coup, tout en laissant le prochain passage traiter le suivant.
          if (result?.reminded) {
            this.nextReminderAt = this.clock() + INACTIVITY_REMINDER_GAP_MS;
            break;
          }
        } catch (error) {
          this.retryAfter.set(ticket.channelId, this.clock() + INACTIVITY_RETRY_MS);
          this.logger.error(`Impossible de vérifier l’inactivité du ticket #${ticket.number} :`, error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  nextRunDelay() {
    const currentTime = this.clock();
    if (!isInactivityAutomationActive(currentTime)) {
      return Math.max(1, nextInactivityAutomationStartAt(currentTime) - currentTime);
    }
    if (this.nextReminderAt > currentTime) return Math.max(1, this.nextReminderAt - currentTime);
    return this.intervalMs;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    const tick = async () => {
      try { await this.run(); }
      catch (error) { this.logger.error('Vérification des tickets inactifs impossible :', error); }
      if (!this.stopped && generation === this.generation) {
        this.timer = setTimeout(tick, this.nextRunDelay());
        this.timer.unref?.();
      }
    };
    void tick();
  }

  stop() {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

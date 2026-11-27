// Les clés sont conservées dans le fichier de données : ne pas les renommer.
export const TICKET_TYPES = Object.freeze([
  {
    key: 'plainte', label: 'Plainte', slug: 'plainte', emoji: '📣',
    description: 'Signaler un problème ou déposer une plainte.',
  },
  {
    key: 'question', label: 'Question', slug: 'question', emoji: '❓',
    description: 'Poser une question à l’équipe.',
  },
  {
    key: 'rc_staff', label: 'RC STAFF', slug: 'rc-staff', emoji: '🛡️',
    description: 'Contacter l’équipe au sujet du staff.',
  },
  {
    key: 'demande_unban', label: 'Demande UNBAN', slug: 'unban', emoji: '🔓',
    description: 'Demander le réexamen d’un bannissement.',
  },
  {
    key: 'fondation', label: 'Fondation', slug: 'fondation', emoji: '🏛️',
    description: 'Faire une demande concernant la Fondation.',
  },
  {
    key: 'partenariat', label: 'Partenariat', slug: 'partenariat', emoji: '🤝',
    description: 'Proposer ou discuter d’un partenariat.',
  },
]);

export const TYPE_BY_KEY = Object.freeze(Object.fromEntries(TICKET_TYPES.map((type) => [type.key, type])));

export const RC_STAFF_WORKFLOW_STATUSES = Object.freeze(['form_sent', 'review', 'oral_accepted', 'oral_refused']);
export const RC_STAFF_ACCEPTED_ROLE_ID = '1555654481058865152';

export const STATUSES = Object.freeze({
  form_sent: { emoji: '📝', label: 'Formulaire envoyé', slug: 'formulaire-envoye', color: 0x3498db },
  review: { emoji: '🔎', label: 'En étude', slug: 'en-etude', color: 0x9b59b6 },
  oral_accepted: { emoji: '✅', label: 'Accepté oral', slug: 'accepte-oral', color: 0x2ecc71 },
  oral_refused: { emoji: '❌', label: 'Refusé oral', slug: 'refuse-oral', color: 0xe74c3c },
  waiting: { emoji: '🔴', label: 'En attente', slug: 'attente', color: 0xe74c3c },
  claimed: { emoji: '🟠', label: 'Pris en charge', slug: 'pris-en-charge', color: 0xe67e22 },
  progress: { emoji: '🟡', label: 'En cours', slug: 'en-cours', color: 0xf1c40f },
  resolved: { emoji: '🟢', label: 'Traité', slug: 'traite', color: 0x2ecc71 },
  closed: { emoji: '⚫', label: 'Fermé', slug: 'ferme', color: 0x7f8c8d },
  deleted: { emoji: '⚫', label: 'Supprimé', slug: 'supprime', color: 0x7f8c8d },
});

export function isRcStaffWorkflowTicket(ticket) {
  return ticket?.type === 'rc_staff' && RC_STAFF_WORKFLOW_STATUSES.includes(ticket.status);
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function ticketNumber(number) {
  return String(number).padStart(4, '0');
}

export function statusLabel(ticket) {
  const status = Object.hasOwn(STATUSES, ticket.status) ? STATUSES[ticket.status] : null;
  if (!status) throw new Error(`Statut de ticket inconnu : ${ticket.status}`);
  if (ticket.status === 'progress' && ticket.progressDetail) {
    const preposition = /^[aeiouyàâäéèêëîïôöùûüÿœæ]/i.test(ticket.progressDetail) ? 'd’' : 'de ';
    return `${status.emoji} En cours ${preposition}${ticket.progressDetail}`;
  }
  return `${status.emoji} ${status.label}`;
}

export function channelName(ticket) {
  const type = Object.hasOwn(TYPE_BY_KEY, ticket.type) ? TYPE_BY_KEY[ticket.type] : null;
  const status = Object.hasOwn(STATUSES, ticket.status) ? STATUSES[ticket.status] : null;
  if (!type || !status) throw new Error('Type ou statut de ticket inconnu.');
  const stateSlug = ticket.status === 'progress'
    ? `en-cours-de-${slugify(ticket.progressDetail).slice(0, 24).replace(/-+$/, '') || 'suivi'}`
    : status.slug;
  const owner = slugify(ticket.ownerName).slice(0, 16).replace(/-+$/, '') || 'membre';
  // Les morceaux sont bornés : le numéro reste visible même avec un long nom.
  return `${status.emoji}-${stateSlug}-${type.slug}-${owner}-${ticketNumber(ticket.number)}`;
}

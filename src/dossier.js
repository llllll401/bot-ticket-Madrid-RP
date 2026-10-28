import { UserError } from './errors.js';

export const MAX_INTERNAL_NOTES = 100;
export const MAX_INTERNAL_NOTE_LENGTH = 800;
export const MAX_ROLE_MESSAGE_LENGTH = 600;

export function cleanDossierText(value, maxLength, label) {
  if (typeof value !== 'string') throw new UserError(`${label} est invalide.`);
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text || text.length > maxLength) {
    throw new UserError(`${label} doit contenir entre 1 et ${maxLength} caractères.`);
  }
  return text;
}

import fs from 'node:fs';
import path from 'node:path';
import { TICKET_TYPES } from './catalog.js';

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_STAFF_ROLES = 25;
const TYPE_KEYS = new Set(TICKET_TYPES.map((type) => type.key));

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Configuration manquante : ${name} dans config.json.`);
  }
  return value.trim();
}

function id(value, name) {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    throw new Error(`Configuration manquante : ${name} dans config.json.`);
  }
  if (typeof value !== 'string' || !SNOWFLAKE.test(value.trim())) {
    throw new Error(`${name} doit être un ID Discord de 17 à 20 chiffres, entre guillemets dans config.json.`);
  }
  return value.trim();
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} doit être un objet dans config.json.`);
  }
  return value;
}

function roles(value, name, guildId, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${name} doit être une liste d’IDs entre guillemets dans config.json.`);
  const result = [...new Set(value.map((role) => id(role, name)))];
  if (!allowEmpty && !result.length) throw new Error(`${name} doit contenir au moins un ID de rôle.`);
  if (result.length > MAX_STAFF_ROLES) throw new Error(`${name} est limité à ${MAX_STAFF_ROLES} rôles.`);
  // Le rôle @everyone a le même identifiant que le serveur.
  if (result.includes(guildId)) throw new Error(`${name} ne peut pas contenir le rôle @everyone.`);
  return result;
}

function checkTypeKeys(value, name) {
  const invalid = Object.keys(value).filter((key) => !TYPE_KEYS.has(key));
  if (invalid.length) throw new Error(`Catégorie inconnue dans ${name} : ${invalid.join(', ')}.`);
}

// `data` vient uniquement de config.json ; les IDs restent des chaînes pour ne
// pas perdre de précision sur les identifiants Discord à 18 ou 19 chiffres.
export function loadConfig(data, configDir = process.cwd()) {
  object(data, 'La configuration');
  const token = requiredString(data.token, 'token');
  const guildId = id(data.serveurId, 'serveurId');
  const defaultStaffRoles = roles(data.rolesStaff, 'rolesStaff', guildId);
  const categories = object(data.categories, 'categories');
  const roleOverrides = data.rolesStaffParCategorie === undefined ? {} : object(data.rolesStaffParCategorie, 'rolesStaffParCategorie');
  checkTypeKeys(categories, 'categories');
  checkTypeKeys(roleOverrides, 'rolesStaffParCategorie');
  const staffRolesByType = {};
  const categoryIdsByType = {};

  for (const type of TICKET_TYPES) {
    categoryIdsByType[type.key] = id(categories[type.key], `categories.${type.key}`);
    const configuredRoles = Object.hasOwn(roleOverrides, type.key)
      ? roles(roleOverrides[type.key], `rolesStaffParCategorie.${type.key}`, guildId, { allowEmpty: true })
      : [];
    staffRolesByType[type.key] = configuredRoles.length ? configuredRoles : [...defaultStaffRoles];
  }

  const dataFile = data.fichierDonnees == null
    ? './data/tickets.json'
    : requiredString(data.fichierDonnees, 'fichierDonnees');
  return { token, guildId, staffRolesByType, categoryIdsByType, dataFile: path.resolve(configDir, dataFile) };
}

export function loadConfigFile(file = path.resolve('config.json')) {
  const absoluteFile = path.resolve(file);
  let contents;
  try {
    contents = fs.readFileSync(absoluteFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Fichier config.json introuvable. Copiez config.example.json en config.json puis remplissez-le.`);
    }
    throw new Error(`Impossible de lire config.json : ${error.code || 'erreur de lecture'}.`);
  }
  let data;
  try {
    data = JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch {
    // Ne pas inclure le contenu : il peut contenir le token du bot.
    throw new Error('config.json est invalide : vérifiez la syntaxe JSON (guillemets et virgules).');
  }
  return loadConfig(data, path.dirname(absoluteFile));
}

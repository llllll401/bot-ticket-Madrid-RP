import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { TICKET_TYPES } from './catalog.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('panneau-tickets')
    .setDescription('Installer le panneau de création de tickets dans ce salon.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('ticket-panneau')
    .setDescription('Réparer le panneau de gestion et le nom du ticket actuel.'),
  new SlashCommandBuilder()
    .setName('ticket-prendre')
    .setDescription('Prendre ou reprendre le ticket actuel.'),
  new SlashCommandBuilder()
    .setName('ticket-fermer')
    .setDescription('Fermer le ticket actuel et supprimer son salon après confirmation.'),
  new SlashCommandBuilder()
    .setName('tickets')
    .setDescription('Consulter les tickets accessibles à votre équipe.')
    .addStringOption((option) => option
      .setName('statut')
      .setDescription('Filtrer par statut (tickets ouverts par défaut).')
      .addChoices(
        { name: 'Tous les tickets ouverts', value: 'active' },
        { name: '🔴 En attente', value: 'waiting' },
        { name: '🟠 Pris en charge', value: 'claimed' },
        { name: '🟡 En cours', value: 'progress' },
        { name: '🟢 Traités', value: 'resolved' },
        { name: '⚫ Anciens tickets fermés', value: 'closed' },
        { name: 'Ouverts et anciens fermés', value: 'all' },
      ))
    .addStringOption((option) => option
      .setName('categorie')
      .setDescription('Filtrer par type de ticket.')
      .addChoices(TICKET_TYPES.map((type) => ({ name: type.label, value: type.key }))))
    .addUserOption((option) => option
      .setName('responsable')
      .setDescription('Afficher les tickets attribués à cette personne.'))
    .addBooleanOption((option) => option
      .setName('mes_tickets')
      .setDescription('Afficher uniquement les tickets qui vous sont attribués.'))
    .addBooleanOption((option) => option
      .setName('sans_responsable')
      .setDescription('Afficher les tickets qui ne sont attribués à personne.'))
    .addStringOption((option) => option
      .setName('priorite')
      .setDescription('Filtrer selon la priorité du ticket.')
      .addChoices(
        { name: '🚨 Urgente', value: 'urgent' },
        { name: 'Normale', value: 'normal' },
      )),
];

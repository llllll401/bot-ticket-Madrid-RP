import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands } from './commands.js';
import { loadConfigFile } from './config.js';
import { createInteractionHandler } from './interactions.js';
import { rejectChannelRenameRateLimit } from './name-sync.js';
import { validateGuildConfiguration } from './permissions.js';
import { registerGuildCommands } from './register.js';
import { TicketStore } from './store.js';
import { TicketService } from './ticket-service.js';

async function main() {
  const config = loadConfigFile();
  const store = new TicketStore(config.dataFile, config.guildId);
  // Aucun intent privilégié ni accès au contenu des messages n'est nécessaire.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { rejectOnRateLimit: rejectChannelRenameRateLimit },
  });
  let service = null;
  let handleInteraction = null;

  client.on(Events.Error, (error) => console.error('Erreur du client Discord :', error));
  client.on(Events.InteractionCreate, (interaction) => {
    if (handleInteraction) void handleInteraction(interaction);
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (service) void service.channelDeleted(channel).catch((error) => console.error('Erreur lors du suivi d’un salon supprimé :', error));
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const guild = await readyClient.guilds.fetch(config.guildId);
      await validateGuildConfiguration(guild, config);
      service = new TicketService({ config, store, botUserId: readyClient.user.id });
      await service.recoverPendingDeletions(guild);
      await service.recoverPendingTransitions(guild);
      await service.syncConfiguredRoles(guild);
      service.resumePendingRenames(guild);
      await registerGuildCommands(guild, commands);
      handleInteraction = createInteractionHandler({ config, service });
      void service.refreshOutdatedPanels(guild).catch((error) => console.error('Mise à jour des anciens panneaux impossible :', error));
      console.log(`Bot connecté en tant que ${readyClient.user.tag}. Serveur autorisé : ${config.guildId}.`);
      console.log('Utilisez /panneau-tickets dans le salon où publier le menu.');
    } catch (error) {
      console.error('Initialisation impossible :', error.message);
      process.exitCode = 1;
      service?.stop();
      await readyClient.destroy();
    }
  });

  const shutdown = async () => {
    console.log('Arrêt du bot…');
    service?.stop();
    await client.destroy();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await client.login(config.token);
  } catch (error) {
    await client.destroy();
    throw error;
  }
}

main().catch((error) => {
  console.error('Démarrage impossible :', error.message);
  process.exitCode = 1;
});

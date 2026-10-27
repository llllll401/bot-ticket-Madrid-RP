import { ApplicationCommandType } from 'discord.js';

// Ne remplace pas les autres commandes éventuellement présentes sur l'application.
export async function registerGuildCommands(guild, commands) {
  const existing = await guild.commands.fetch();
  for (const command of commands) {
    const data = command.toJSON();
    const found = existing.find((item) => item.name === data.name && item.type === ApplicationCommandType.ChatInput);
    if (found) await guild.commands.edit(found.id, command);
    else await guild.commands.create(command);
  }
}

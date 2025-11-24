require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
    new SlashCommandBuilder().setName('submit').setDescription('Submit a song to the community'),
    new SlashCommandBuilder().setName('profile').setDescription('Check your stats privately'),
    // NEW COMMAND
    new SlashCommandBuilder().setName('share-profile').setDescription('Post your stats publicly for everyone to see'),
    
    new SlashCommandBuilder()
        .setName('top')
        .setDescription('Find top rated songs by genre')
        .addStringOption(option => 
            option.setName('genre').setDescription('The Macro Genre').setRequired(true)
            .addChoices(
                { name: 'EDM: House & Techno', value: 'EDM: House & Techno' },
                { name: 'EDM: Trance & Synth', value: 'EDM: Trance & Synth' },
                { name: 'EDM: Bass & Breakbeat', value: 'EDM: Bass & Breakbeat' },
                { name: 'Rock: Classic & Hard', value: 'Rock: Classic & Hard' },
                { name: 'Rock: Metal & Heavy', value: 'Rock: Metal & Heavy' },
                { name: 'Rock: Indie & Alt', value: 'Rock: Indie & Alt' },
                { name: 'Hip Hop & Rap', value: 'Hip Hop & Rap' },
                { name: 'Pop & R&B', value: 'Pop & R&B' },
                { name: 'Country: Modern & Pop', value: 'Country: Modern & Pop' },
                { name: 'Cinematic & Score', value: 'Cinematic & Score' },
                { name: 'Experimental & AI', value: 'Experimental & AI' }
            )),

    new SlashCommandBuilder().setName('init-leaderboard').setDescription('Admin Only: Spawn the leaderboard'),
    new SlashCommandBuilder().setName('init-welcome').setDescription('Admin Only: Spawn the TOS Gate'),
    
    new SlashCommandBuilder()
        .setName('admin-delete')
        .setDescription('Admin Only: Remove a song from DB and Discord')
        .addIntegerOption(option => option.setName('song_id').setDescription('The ID of the song to remove').setRequired(true)),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
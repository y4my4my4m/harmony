# Harmony Bot Plugins

## 🎉 Welcome!

This directory contains official and community-created bot plugins for Harmony.

## 📁 Directory Structure

```
bot-plugins/
├── discord-bridge/      # Official Discord bridge (reference implementation)
├── template/            # Plugin template for developers
├── community/           # Community-contributed plugins
└── examples/            # Example bots
```

## 🚀 Quick Start

### Using an Existing Plugin

1. Navigate to plugin directory:
```bash
cd bot-plugins/discord-bridge
```

2. Install dependencies:
```bash
npm install
```

3. Configure:
```bash
cp config/bridge-config.example.yml config/bridge-config.yml
nano config/bridge-config.yml
```

4. Run:
```bash
npm run dev
```

### Creating Your Own Plugin

1. Copy the template:
```bash
cp -r template/ my-bridge/
cd my-bridge/
```

2. Follow template README

3. Read [Plugin System Guide](../docs/PLUGIN_SYSTEM.md)

## 📦 Official Plugins

### Discord Bridge

**Status:** ✅ Production Ready

Cross-platform bridge connecting Discord and Harmony servers.

**Features:**
- Bi-directional message sync
- Mention and emoji translation
- Attachment support
- Loop prevention
- Configurable mappings

**Directory:** `discord-bridge/`

**Documentation:** [Discord Bridge README](discord-bridge/README.md)

## 🌟 Community Plugins

### How to Contribute

1. Create your plugin following the [Plugin System Guide](../docs/PLUGIN_SYSTEM.md)
2. Test thoroughly
3. Add comprehensive README
4. Submit PR to `community/your-plugin/`

### Submission Requirements

- ✅ Complete README with setup instructions
- ✅ Example configuration file
- ✅ Error handling and logging
- ✅ Graceful shutdown
- ✅ TypeScript or well-typed JavaScript
- ✅ No hardcoded credentials
- ✅ License file (must be compatible with how you distribute the plugin; Harmony core is **AGPL-3.0**)

## 📖 Documentation

- [Plugin System Guide](../docs/PLUGIN_SYSTEM.md) - Architecture and patterns
- [Bot API Reference](../docs/BOT_API.md) - API documentation
- [E2EE Implementation](../docs/E2EE_IMPLEMENTATION.md) - Encryption details

## 🔗 Resources

- **Harmony Bot API:** http://localhost:3001/api/v1
- **WebSocket Gateway:** ws://localhost:3001/gateway
- **Documentation:** https://docs.harmonyapp.dev

## 💡 Plugin Ideas

Looking for inspiration? Try building:

- 🔔 **RSS Feed Bot** - Post updates from RSS feeds
- 🐙 **GitHub Bot** - Repository notifications
- 📊 **Stats Bot** - Server analytics and insights
- 🎮 **Game Bot** - Mini-games and entertainment
- 🌐 **Translation Bot** - Auto-translate messages
- 🎵 **Music Bot** - Voice channel music player
- 🛡️ **Moderation Bot** - Advanced auto-moderation
- 📺 **Twitch Bot** - Stream notifications
- 🔍 **Search Bot** - Advanced message search
- 🤖 **AI Bot** - ChatGPT integration

## 🧪 Testing

### Local Testing Setup

1. Start Harmony app:
```bash
cd ../
npm run dev
```

2. Start bot gateway:
```bash
cd bot-gateway/
npm run dev
```

3. Start your plugin:
```bash
cd bot-plugins/your-plugin/
npm run dev
```

### Test Checklist

- [ ] Bot connects to gateway successfully
- [ ] Bot receives events
- [ ] Bot can send messages
- [ ] Permissions are checked correctly
- [ ] Rate limiting works
- [ ] Error handling works
- [ ] Graceful shutdown works
- [ ] Configuration is validated
- [ ] Logs are helpful
- [ ] No sensitive data in logs

## 🐛 Debugging

### Enable Debug Logging

```typescript
// In your bot
process.env.DEBUG = 'harmony:*'
```

### Common Issues

**"Authentication failed"**
- Check bot token is correct
- Verify token hasn't been revoked
- Ensure bot is active

**"Missing permissions"**
- Add bot to server
- Configure bot permissions
- Check channel-specific permissions

**"Messages not bridging"**
- Verify channel mappings
- Check both bots are online
- Review logs for errors
- Ensure loop prevention isn't blocking

**"Connection refused"**
- Check bot-gateway is running
- Verify gateway URL in config
- Check firewall/network settings

## 📞 Support

### Getting Help

1. Check documentation
2. Review existing plugins
3. Ask in Harmony Discord
4. Open GitHub issue

### Reporting Bugs

Include:
- Plugin name and version
- Error message and logs
- Steps to reproduce
- Configuration (without tokens!)

## 🏆 Featured Plugins

Have a great plugin? We'll feature it here!

Submit via PR with:
- Working code
- Documentation
- Example configuration
- Demo video/screenshots (optional)

## 📄 License

Each plugin may document its own terms. The Discord bridge in this repo follows the root **AGPL-3.0** `LICENSE`.

---

**Happy building! 🚀**

For questions, check [docs/PLUGIN_SYSTEM.md](../docs/PLUGIN_SYSTEM.md) or reach out to the community.


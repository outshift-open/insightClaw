# Install plugin

`$ openclaw plugins install --dangerously-force-unsafe-install /path/to/plugin/`

The `--dangerously-force-unsafe-install` flag is needed as the plugin is executing shell scripts on the host.

# Usage

Two commands are added with this plugin:

`/scenario input`: `input` should be an integer corresponding to the scenario number (currently 1 or 2). This is synchronous.
`/reset_session`: This command will erase all sessions for the 6 agents in our SRE triage MAS, and will spawn one new session for both the comms agent and the verifier agent. This command is asynchronous. A message is sent on the channel used (usually Discord) to notify that everything was done successfully (it take ~1 min to complete).

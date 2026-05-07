# NemoClaw Install

This directory contains the assets needed to spin up a NemoClaw instance for our SRE triage sample MAS.

In details, there is a `install.sh` file that can be run to deploy everything. In effect, this script clones NemoClaw repository, checks out a given version (passed as a parameter), installs it, applies the patch for the selected version, copies `sample-MAS/sre-triage` and our observability plugin, and finally runs `nemoclaw onboard`.

A set of folders, with the templated name `nemoclaw-vX.Y.Z`, contains the files needed for the different NemoClaw versions that are supported.

## Prerequisites

You need to have the following installed on your machine for the installation script to run:
- `bash`
- `git`
- `node` (version 22 or higher)
- `npm`


## Usage

Run the installer against a remote host in `user@host` form:

Run the installer for a supported NemoClaw version:
```bash
$ bash install.sh <NEMOCLAW_VERSION>
```

The parameter NEMOCLAW_VERSION must be a version that is supported by our installer (i.e., the folder `nemoclaw-${NEMOCLAW_VERSION}` exists).

In addition, the script supports the following flags:
`--help | -h` : Display an help messag and exit.
`--cleanup | -c` : Clean up installed NemoClaw and related files. In effect, this will remove the ${TARGET_DIR} folder (see below for more information about the environment variables used by the script).

The script is making use of a set of environment variables:

| Env variable | Description | Default value |
| :---: | :---: | :---: |
| NEMOCLAW_ENDPOINT_URL | - MANDATORY - Your LLM provider endpoint | `https://your-endpoint.example.com` |
| COMPATIBLE_API_KEY | - MANDATORY - Your LLM provider API key | `None` |
| OTEL_ENDPOINT | The otel collector endpoint. should be of format http(s)://host:port | `None` |
| TARGET_DIR | Where you want to download the NemoClaw repo | `/home/ubuntu/NemoClaw` |
| NEMOCLAW_REPO_URL | The url to the NemoClaw repo | https://github.com/NVIDIA/NemoClaw.git |
| LOCAL_TRIAGE_DIR | The path to the SRE triage data | `sample-MAS/sre-triage/data` |
| NEMOCLAW_PROVIDER | How you want your NemoClaw instance to reach your LLM provider | `custom` |
| NEMOCLAW_MODEL | The LLM model to be used | `vertex_ai.gemini-2.5-pro` |
| NEMOCLAW_DOCKERFILE | The path to the Dockerfile to be used for NemoClaw onboarding | The default dockerfile |


What the script does:

1. Checks that the prerequisites are present.
2. Clones the NemoClaw repository to the $TARGET_DIR and checks out the $NEMOCLAW_VERSION. It then installs NemoClaw from source.
3. Applies the patches present in the `nemoclaw-${NEMOCLAW_VERSION}` folder.
4. Prepare the building of the OpenShell image by adding the SRE triage sample MAS assets and our observability plugin.
5. Runs `nemoclaw onboard` non-interactively with the configured model settings.

## Enter The Sandbox

Once the install is finished, you can access your NemoClaw instance:

```bash
nemoclaw my-assistant connect
```

This opens a shell inside the NemoClaw sandbox.

To open the SRE lead chat from inside the sandbox, run:

```bash
openclaw tui
```

## Change The DB API Scenario

Our SRE triage sample MAS comes with two scenarios:
1. `1`: payment async timeout
2. `2`: order DB deadlock

Once you are in the sandbox (`nemoclaw my-assistant connect`), you can inspect the currently loaded scenario with the `GET /scenario` endpoint:

```bash
curl http://127.0.0.1:8765/scenario
```
The response includes the selected scenario number, fixture file name, incident id, and loaded services.

You can also switch the scenario by running:

```bash
curl -X POST http://127.0.0.1:8765/scenario \
  -H "Content-Type: application/json" \
  -d '{"scenario": 1}'
```

To list all available scenarios and see which one is currently selected, use the `GET /scenarios` endpoint:

```bash
curl http://127.0.0.1:8765/scenarios
```

## Scripts inside the sandbox

Two scripts are provided along with the SRE triage sample MAS:
- `change-scenario.sh <SCENARIO_ID>`: This allow to switch the scenario loaded (see previous section).
- `reset-session.sh`: This will reset all the sessions for the different agents deployed for our SRE triage MAS. It should be run before any SRE triage run.

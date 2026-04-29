# NemoClaw Remote Install

This directory contains the assets used to prepare a remote NemoClaw checkout for the SRE triage sample.

Files:

- `install_nemoclaw_remote.sh`: clones NemoClaw on a remote host, checks out a fixed tag, applies the local patch, copies `sample-MAS/sre-triage` into the remote repo, and runs `nemoclaw onboard`.
- `nemoclaw-nuc-v0.0.20.diff`: local patch applied to the upstream NemoClaw checkout before onboarding.

## Prerequisites

- Local machine:
  - `bash`
  - `ssh`
  - `scp`
  - this repository checked out with `sample-MAS/sre-triage` present
- Remote machine:
  - `git`
  - `nemoclaw`
  - SSH access from the local machine

## Usage

Run the installer against a remote host in `user@host` form:

```bash
COMPATIBLE_API_KEY=your-key \
./sample-MAS/sre-triage/nemoclaw/install_nemoclaw_remote.sh user@host
```

What the script does:

1. Validates local assets and remote connectivity.
2. Clones the NemoClaw repository on the remote host and checks out `v0.0.20` by default.
3. Applies `nemoclaw-nuc-v0.0.20.diff` on the remote checkout.
4. Copies `sample-MAS/sre-triage` into the remote repo as `sre-triage/openclaw`.
5. Runs `nemoclaw onboard` non-interactively with the configured model settings.

## Dry Run

Use `DRY_RUN=1` to print the `ssh` and `scp` commands without changing the remote machine:

```bash
DRY_RUN=1 ./sample-MAS/sre-triage/nemoclaw/install_nemoclaw_remote.sh user@host
```

In dry-run mode, the script still validates the local patch and sample directory, but it does not require `COMPATIBLE_API_KEY` and does not connect to or modify the target host.

## Clean Mode

Use `CLEAN=1` to remove remote install directories and exit without running clone, patch, copy, or onboarding steps:

```bash
CLEAN=1 ./sample-MAS/sre-triage/nemoclaw/install_nemoclaw_remote.sh user@host
```

This removes:

- `TARGET_DIR` (default `~/NemoClaw`)
- `REMOTE_TRIAGE_DIR` (default `~/NemoClaw/sre-triage`)

You can combine it with `DRY_RUN=1` to preview the clean commands:

```bash
CLEAN=1 DRY_RUN=1 ./sample-MAS/sre-triage/nemoclaw/install_nemoclaw_remote.sh user@host
```

## Environment Variables

- `TARGET_DIR`: remote path for the NemoClaw checkout. Default: `~/NemoClaw`
- `NEMOCLAW_REPO_URL`: upstream NemoClaw git URL. Default: `https://github.com/NVIDIA/NemoClaw.git`
- `NEMOCLAW_TAG`: git tag checked out on the remote host. Default: `v0.0.20`
- `DIFF_FILE`: local patch file to apply remotely. Default: `sample-MAS/sre-triage/nemoclaw/nemoclaw-nuc-v0.0.20.diff`
- `LOCAL_TRIAGE_DIR`: local source directory copied to the remote repo. Default: `sample-MAS/sre-triage`
- `REMOTE_TRIAGE_DIR`: remote directory used to stage the sample. Default: `~/NemoClaw/sre-triage`
- `NEMOCLAW_PROVIDER`: provider passed to onboarding. Default: `custom`
- `NEMOCLAW_ENDPOINT_URL`: endpoint passed to onboarding. Default: `https://your-endpoint.example.com`
- `NEMOCLAW_MODEL`: model passed to onboarding. Default: `vertex_ai/gemini-2.5-pro`
- `NEMOCLAW_ONBOARD_FROM`: Dockerfile path passed to `nemoclaw onboard --from`. Default: `~/NemoClaw/Dockerfile`
- `COMPATIBLE_API_KEY`: required for a real onboarding run
- `DRY_RUN`: set to `1` to print planned actions only
- `CLEAN`: set to `1` to remove remote install directories and exit

## Notes

- The remote sample is copied under `sre-triage/openclaw` because the patch expects Docker build paths rooted there.
- The script uses `git clean -fdx` on the remote NemoClaw checkout before applying the patch, so local changes inside the remote checkout will be removed.
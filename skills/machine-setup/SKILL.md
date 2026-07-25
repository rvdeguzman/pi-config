---
name: machine-setup
description: "Detect the current machine and verify/apply its dotfiles + system-level setup. Use when setting up a new machine, or auditing whether an existing machine matches this repo (chezmoi state, package lists, machine-specific system fixes like the MiniBook X rotation stack)."
---

# Machine Setup Skill

Set up or audit a machine against this repo. **Detect first, never ask what you can
determine.** Only prompt the user for genuine choices (which package profiles, whether
to fix detected drift).

Repo layout facts you need:
- chezmoi source root is `home/` (see `.chezmoiroot`), applied in **symlink mode** —
  files in `$HOME` should be symlinks into this repo.
- Per-machine behavior is driven by chezmoi data in `~/.config/chezmoi/chezmoi.toml`
  (generated from `home/.chezmoi.toml.tmpl`): `hyprland`, `minibook`, `packages`.
- Package profiles: `packages/arch/*.txt` and `packages/macos/*`.
- Machine-specific system notes live in `docs/` (e.g. `docs/minibook-x.md`).

## Step 1 — Identify the machine (deterministic)

```bash
uname -s                                  # Darwin vs Linux
cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null
```

Map the result:
- `product_name` contains `MiniBook X` → **Chuwi MiniBook X**, read `docs/minibook-x.md`
  and run the MiniBook checks in Step 4.
- `Darwin` → macOS profile (`packages/macos`, aerospace/karabiner configs).
- Anything else → generic Linux; skip machine-specific fixes.

Also detect the environment so you can pick sane defaults instead of asking:
```bash
echo "${HYPRLAND_INSTANCE_SIGNATURE:-}"   # non-empty => Hyprland is running
command -v pacman paru yay 2>/dev/null
```

## Step 2 — Is chezmoi actually managing this machine?

This is the highest-value check; it's easy to have a repo checkout that was never applied.

```bash
command -v chezmoi || echo "chezmoi MISSING"
cat ~/.config/chezmoi/chezmoi.toml 2>/dev/null || echo "NOT INITIALIZED"
ls -ld ~/.config/hypr                      # symlink => managed, real dir => NOT managed
chezmoi status --source ~/repos/dotfiles 2>/dev/null   # non-empty => drift
```

Interpretation:
- No `chezmoi.toml` → repo was never `chezmoi init`'d here. Live configs are unmanaged
  copies. Fix with `./setup` from the repo root.
- `~/.config/*` is a **real directory** instead of a symlink → same conclusion, that
  path is unmanaged and has likely drifted.
- If drift exists, **diff before overwriting** — the live copy may contain newer edits
  worth pulling back into the repo:
  ```bash
  diff -rq ~/.config/hypr ~/repos/dotfiles/home/dot_config/hypr-minibook
  ```
  Report the differences and ask which direction to reconcile. Never blindly
  `chezmoi apply` over drifted configs.

## Step 3 — Packages

```bash
# For each selected profile, list what's declared but not installed:
comm -23 <(grep -vE '^\s*(#|$)' packages/arch/base.txt | sort) \
         <(pacman -Qq | sort)
```
Applying is handled automatically by
`home/.chezmoiscripts/run_onchange_after_linux-install-packages.sh.tmpl` on
`chezmoi apply` (it needs `paru` or `yay`). Prefer letting that script do the install
rather than invoking the AUR helper by hand.

Also check the reverse gap: machine-critical packages that are installed but **not
declared** in any `packages/arch/*.txt`. Those are reproducibility holes — report them.

## Step 4 — Machine-specific system layer (outside chezmoi's reach)

chezmoi only manages `$HOME`. Kernel args, bootloader, `/etc/modprobe.d`, and system
services are **not** covered, so verify them explicitly.

### Chuwi MiniBook X

Full rationale is in `docs/minibook-x.md`. Verify each layer:

```bash
# 1. kernel/console/splash rotation
grep -o 'video=DSI-1:panel_orientation=[a-z_]*' /proc/cmdline || echo "MISSING panel_orientation"

# 2. bootloader menu rotation
grep '^interface_rotation:' /boot/limine.conf || echo "MISSING interface_rotation"

# 3. compositor + touch rotation (expect transform 3 / transform = 3)
grep -n 'transform' ~/.config/hypr/monitors.conf ~/.config/hypr/input.conf

# 4. modprobe tweaks
cat /etc/modprobe.d/hid_apple.conf /etc/modprobe.d/disable-usb-autosuspend.conf 2>/dev/null

# 5. tablet-mode daemons (note: units are NOT named "minibook*")
pacman -Q minibook-support-git
for s in tabletmoded keyboardd trackpadd; do
  echo "$s: enabled=$(systemctl is-enabled $s 2>&1) active=$(systemctl is-active $s 2>&1)"
done
```

Expected good state: `panel_orientation=right_side_up`, `interface_rotation: 90`,
`transform 3` in both hypr files, `tabletmoded`/`keyboardd` enabled+active.

Gotchas that will otherwise waste your time:
- `trackpadd` shows **disabled but active** — correct, `tabletmoded` pulls it in via
  `Requires=`. Not a bug.
- Searching `systemctl list-unit-files | grep minibook` returns nothing. The units are
  `tabletmoded` / `keyboardd` / `trackpadd`.
- The AUR `.install` hook references a stale unit name `moused` (renamed `trackpadd`),
  so that hook line silently no-ops. Harmless.
- `iio-sensor-proxy` is intentionally **not** installed; `tabletmoded` reads both
  `mxc4005` accelerometers directly.
- Tablet mode ≠ screen auto-rotation. minibook-support only does fold detection;
  display rotation is static. Don't report missing auto-rotate as a broken install.

## Step 5 — Report

Produce a short table of layer → expected → actual → OK/DRIFT/MISSING. Then propose
fixes in priority order and confirm before mutating anything that needs `sudo` or that
would overwrite live config.

Keep changes idempotent and re-runnable. If you discover a new machine-specific fix
that isn't captured in the repo, add it to `docs/<machine>.md` (and a package list if
relevant) so the next setup is reproducible.

#!/bin/sh
# Install the chopin CLI from a githubnext/chopin release, for Linux and macOS on x64 or arm64.
#
#   curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh -s -- 0.2.0
#
# CHOPIN_VERSION              the version to install, like the argument (default: the newest release)
# CHOPIN_VERIFY_ATTESTATION   0 skips `gh attestation verify`, which otherwise runs when gh is installed
# CHOPIN_RELEASE_BASE_URL     where cli-v<version>/ assets are downloaded from
# CHOPIN_RELEASES_API_URL     the GitHub API list of releases used to find the newest version
#
# Both URLs must be https://, except on 127.0.0.1, localhost or [::1]; redirects must be https.
#
# chopin goes to ~/.local/bin. Nothing here needs, or asks for, administrator rights.
set -eu

REPOSITORY="githubnext/chopin"
BASE_URL="${CHOPIN_RELEASE_BASE_URL:-https://github.com/$REPOSITORY/releases/download}"
RELEASES_API_URL="${CHOPIN_RELEASES_API_URL:-https://api.github.com/repos/$REPOSITORY/releases}"

fail() {
	printf 'chopin install: %s\n' "$1" >&2
	exit 1
}

# Plain http is accepted only from a server on this machine, as the tests use.
allowed_url() {
	case "$1" in
	https://*) return 0 ;;
	http://*) ;;
	*) return 1 ;;
	esac
	authority="${1#http://}"
	authority="${authority%%[/?#]*}"
	case "$authority" in
	*@*) return 1 ;;
	127.0.0.1 | 127.0.0.1:* | localhost | localhost:* | '[::1]' | '[::1]':*) return 0 ;;
	*) return 1 ;;
	esac
}
for setting in "CHOPIN_RELEASE_BASE_URL=$BASE_URL" "CHOPIN_RELEASES_API_URL=$RELEASES_API_URL"; do
	allowed_url "${setting#*=}" \
		|| fail "${setting%%=*} must be an https:// URL (or http:// on 127.0.0.1, localhost or [::1]), not ${setting#*=}."
done

# Redirects are followed only to https.
download() {
	case "$1" in
	https://*) protocols='=https' ;;
	*) protocols='=http,https' ;;
	esac
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --proto "$protocols" --proto-redir '=https' --retry 3 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		# wget follows a redirect to plain http whatever its options (--https-only applies only to
		# recursive downloads), so the redirects it followed are read from its response headers.
		wget -q -S --tries=3 -O "$2" "$1" 2>"$2.headers" || return 1
		if grep -Ei '^[[:space:]]*location:[[:space:]]*[a-z][a-z0-9+.-]*:' "$2.headers" \
			| grep -Eqiv 'location:[[:space:]]*https://'; then
			rm -f "$2"
			fail "$1 was redirected to a URL that is not HTTPS. Refusing to use it."
		fi
	else
		fail "curl or wget is required to download chopin. Install curl (for example sudo apt install curl), then run this command again."
	fi
}

[ -n "${HOME:-}" ] || fail "HOME is not set, so there is no ~/.local/bin to install into."
directory="$HOME/.local/bin"
target="$directory/chopin"
# mv would move the new chopin into a directory there instead of replacing it.
[ ! -d "$target" ] || fail "$target is a directory, so chopin cannot be installed there. Move it out of the way and run this again."

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) fail "$(uname -s) is not supported. chopin is released for Linux and macOS (use install.ps1 on Windows)." ;;
esac

case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "the $(uname -m) architecture is not supported. chopin is released for x64 and arm64." ;;
esac
# A shell under Rosetta reports x86_64 on Apple silicon; the native binary is the one to install.
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
	arch=arm64
fi
asset="chopin-$os-$arch"

if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
	sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
	fail "sha256sum or shasum is required to verify the download."
fi

scratch="$(mktemp -d 2>/dev/null || mktemp -d -t chopin-install)"
staged=""
trap 'rm -rf "$scratch"; [ -z "$staged" ] || rm -f "$staged"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

version="${1:-${CHOPIN_VERSION:-}}"
if [ -z "$version" ]; then
	download "$RELEASES_API_URL?per_page=100" "$scratch/releases.json" \
		|| fail "could not list releases from $RELEASES_API_URL. Check your connection and any proxy (HTTPS_PROXY), then run this command again."
	version="$(tr -d '\n\r' <"$scratch/releases.json" \
		| grep -o '"tag_name"[[:space:]]*:[[:space:]]*"cli-v[^"]*"' \
		| head -n 1 | sed 's/.*"cli-v\([^"]*\)"$/\1/')"
	[ -n "$version" ] || fail "no chopin CLI release (a cli-v* tag) was found."
fi
version="${version#cli-}"
version="${version#v}"
# grep matches line by line, so a version with a newline, or any byte but these, is refused first.
not_a_version="\"$version\" is not a version like 0.2.0."
case "$version" in
*[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+-]*) fail "$not_a_version" ;;
esac
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' \
	|| fail "$not_a_version"

release="$BASE_URL/cli-v$version"
printf 'Installing chopin %s (%s) from %s\n' "$version" "$asset" "$release"
offline="Check your connection and any proxy (HTTPS_PROXY), then run this command again."
download "$release/$asset" "$scratch/$asset" || fail "could not download $release/$asset. $offline"
download "$release/checksums.txt" "$scratch/checksums.txt" \
	|| fail "could not download $release/checksums.txt. $offline"

# A checksums.txt saved with Windows line endings ends each name with \r.
expected="$(awk -v name="$asset" '{ sub(/\r$/, "") } $2 == name || $2 == "*" name { print $1; exit }' "$scratch/checksums.txt")"
[ -n "$expected" ] || fail "checksums.txt has no entry for $asset."
actual="$(sha256 "$scratch/$asset")"
if [ "$actual" != "$expected" ]; then
	fail "the SHA-256 of $asset is $actual, but checksums.txt says $expected. Refusing to install it. Run the command again; if it fails the same way, report it at https://github.com/githubnext/chopin/issues."
fi
echo "Verified the SHA-256 checksum."

if [ "${CHOPIN_VERIFY_ATTESTATION:-1}" != 0 ] && command -v gh >/dev/null 2>&1; then
	gh attestation verify "$scratch/$asset" -R "$REPOSITORY" \
		|| fail "gh attestation verify could not confirm $asset was built by $REPOSITORY. Refusing to install it. (CHOPIN_VERIFY_ATTESTATION=0 skips this check.)"
	echo "Verified the build provenance attestation."
fi

chmod 755 "$scratch/$asset"
reported="$("$scratch/$asset" --version 2>&1)" \
	|| fail "the downloaded chopin does not run on this machine: $reported"

# shellcheck disable=SC2016 # printed for the user to paste, unexpanded.
unwritable="$directory isn't writable by you, so chopin can't be installed there. Make it yours with: sudo chown -R \"\$(id -un)\" \"\$HOME/.local\", then run this command again."
mkdir -p "$directory" 2>/dev/null || fail "$unwritable"
# Copy beside the destination first, into a new file of its own, so the rename that replaces an
# older chopin is atomic and nothing already at a predictable name is written through.
staged="$(mktemp "$directory/.chopin.XXXXXX" 2>/dev/null)" || fail "$unwritable"
cp "$scratch/$asset" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$target"
staged=""

printf 'Installed %s at %s\n' "$reported" "$target"
case ":${PATH:-}:" in
*":$directory:"*) ;;
*)
	printf '\n%s is not on your PATH. Add it to your shell profile:\n' "$directory"
	# shellcheck disable=SC2016 # printed for the user to paste, unexpanded.
	printf '  export PATH="$HOME/.local/bin:$PATH"\n'
	;;
esac

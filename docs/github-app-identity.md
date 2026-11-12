# GitHub App identity

Builds, investigations, prototypes and Planners that run on people's machines
reach GitHub as Chopin's GitHub App, through its bot account `<slug>[bot]`, not as
a person. For each piece of work, Chopin's server asks GitHub for an installation token
that works on one repository and expires after an hour. GitHub only issues that
token to a request signed with the App's private key, so the server needs the
App's ID and a private key. Before each token goes out, the server checks that
the person the work is for can push to the repository. The pull request then
credits that person.

This page sets that up. It assumes the App is already registered and installed,
as [Register the GitHub App](self-hosting.md#register-the-github-app) describes.

## Who can do this

- For an App owned by an organization: an owner of that organization, or a
  GitHub App manager for that App.
- For an App owned by a personal account: that account.

You also need to edit the Chopin server's configuration and restart it.

## Permissions

A machine's token asks for these repository permissions and no others. The App
must have each one, and every installation must have accepted it.

| Permission    | Access         | What the token does with it                                                                                                                                            |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contents      | Read and write | Required. Fetches and pushes branches. A prototype's token only reads.                                                                                                 |
| Pull requests | Read and write | Required. Opens and updates pull requests and requests reviews.                                                                                                        |
| Metadata      | Read-only      | GitHub grants it to every App. The server reads with it whether a person can push.                                                                                     |
| Workflows     | Read and write | Optional. Lets a Build push changes to `.github/workflows`. The token asks for it only when the installation has it; without it, GitHub refuses a push to those files. |

What each launch gets:

| Launch                            | Token permissions                                                         | Credits                   |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| A build, rebuild or investigation | Contents and Pull requests write, Metadata read, Workflows write if given | The person who started it |
| A prototype                       | Contents read, Metadata read                                              | The person who started it |
| A Planner running on a machine    | Contents and Pull requests write, Metadata read, Workflows write if given | The machine's owner       |

The App's other permissions (Checks, Commit statuses, Issues) serve signed-in
people's tools, not machine tokens; see
[Repository permissions](authentication.md#repository-permissions).

## Set it up

1. Open the App's settings. On GitHub, click your profile picture, then:
   - for an App owned by a personal account, **Settings**;
   - for an App owned by an organization, **Your organizations**, then
     **Settings** next to the organization.

   Then click **Developer settings**, **GitHub Apps**, and **Edit** next to the
   App. The address is `https://github.com/settings/apps/<slug>` or
   `https://github.com/organizations/<org>/settings/apps/<slug>`.
2. Click **Permissions & events**. Check that **Contents** and **Pull requests**
   are **Read and write**. If you change a permission, click **Save changes**.
   GitHub then asks every account that installed the App to accept the change,
   and tokens get the new permission only after it does.
3. Click **General**. Under **About**, copy the **App ID**. It is a number. The
   **Client ID** beside it is a different value, which `GITHUB_APP_CLIENT_ID`
   already holds.
4. Click **Credentials**, then **Key pairs**, then **New key**. Your browser
   downloads a file named like `<slug>.<date>.private-key.pem`. GitHub keeps
   only the public half, so if you lose the file, make another key. If your
   settings have no **Credentials** page, the button is **Generate a private
   key**, under **Private keys** at the bottom of **General**.
5. Check the file is the key GitHub lists. Run this where you downloaded it. Its
   output must match the fingerprint GitHub shows for the new key:

   ```bash
   openssl rsa -in <downloaded>.pem -pubout -outform DER | openssl sha256 -binary | openssl base64
   ```
6. Copy the file to the server host (with `scp`, for example). On the host,
   store it readable only by the account that runs Chopin, then delete the copy
   you uploaded:

   ```bash
   sudo install -D -m 0600 -o <service-user> <uploaded>.pem /etc/chopin/github-app.pem
   rm <uploaded>.pem
   ```

   The Docker image runs as user ID 1000, so for it use `-o 1000 -g 1000`.
   Delete the downloaded file on your own computer too. If your platform has a
   secret manager that mounts files, store the key there instead. Never commit
   the key, paste it into an issue or chat, or print it in a log. Chopin never
   prints the key or its path.
7. Add two lines to the server's environment file, such as
   `/etc/chopin/chopin.env`:

   ```dotenv
   GITHUB_APP_ID=<App ID from step 3>
   GITHUB_APP_PRIVATE_KEY_FILE=/etc/chopin/github-app.pem
   ```

   With the Docker image, the variable names the path inside the container. Set
   `GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem` in the file, and
   add this option to `docker run`:

   ```bash
   --volume /etc/chopin/github-app.pem:/run/secrets/github-app.pem:ro
   ```

   A platform that takes only environment values can use
   `GITHUB_APP_PRIVATE_KEY` instead, holding the PEM text with each line break
   written as `\n`. Set one of the two, not both.

   `GITHUB_APP_SLUG` must be the App's slug, because the bot is
   `<GITHUB_APP_SLUG>[bot]`.
8. Restart Chopin. With Docker, remove the container and run it again with the
   new option. The server and `bun run migrate` read the key once, when they
   start.

## Check it works

**At startup.** A bad value stops the server, and `bun run migrate`, with one of
these errors:

| Error                                                                       | Fix                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID must be the GitHub App's numeric ID`                         | Set the App ID from step 3, not the Client ID.                                          |
| `GITHUB_APP_ID needs GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE` | Set the key file from step 7.                                                           |
| `Set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE, not both`       | Remove one.                                                                             |
| `GITHUB_APP_PRIVATE_KEY_FILE can't be read`                                 | Fix the path, or the file's owner. In Docker, the path is the one inside the container. |
| `The GitHub App private key must be a PEM private key`                      | Use the downloaded `.pem` file whole, from `-----BEGIN` to the last `-----`.            |
| `The GitHub App private key must be an RSA key`                             | Use a key GitHub generated for the App.                                                 |

Startup does not ask GitHub, so an App ID and key that don't belong together
start without an error. Step 5 catches a wrong key.

**From a paired machine.** On a machine paired with this Chopin, with a checkout
registered by `chopin connect --checkout <path>`, run:

```bash
chopin status --json
```

The first line of `chopin status` without `--json` must say
`connector protocol 7` or later; an older connector doesn't ask. Look at
`github`. It maps each registered checkout's repository to a result:

```json
"github": { "octo-org/score": "ok" }
```

| Result    | Meaning                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`      | Chopin would give this machine a token for the repository. Nothing was minted.                                                                           |
| A refusal | One of the codes under [Refusals](#refusals). `chopin status` without `--json` adds a sentence about it to that repository's **Checkouts** line.         |
| `unknown` | Chopin couldn't answer: the machine isn't paired or accepted, the server can't be reached or predates this check, or GitHub rejected the App ID and key. |

**In the server log.** Each token the server issues writes one line, without the
token:

```text
chopin: GitHub App token (run build) for machine <machine-id> in octo-org/score, run <run-id>, document <document-id>, for mona
```

## Refusals

When the server gives no token, the launch doesn't start. The machine never uses
its owner's own GitHub login instead. Each refusal names the repository.

| Code                   | Why                                                                                                                                                                                                          | Fix                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `no-grant`             | The server has no App ID and key.                                                                                                                                                                            | [Set it up](#set-it-up).                                                                                             |
| `app-cannot-push`      | The App isn't installed on the repository, its installation is suspended, it lacks a permission from the table above, or the server can't find the bot `<GITHUB_APP_SLUG>[bot]`.                             | Install the App on the repository, accept its pending permissions on the installation, or correct `GITHUB_APP_SLUG`. |
| `starter-cannot-push`  | The person the token is for can't push to the repository: whoever started the run, or the machine's owner for a Planner or `chopin status`. Also when their GitHub login now belongs to a different account. | Give that person write access, then start the work again.                                                            |
| `repository-forbidden` | The machine's owner can't see the repository through the App.                                                                                                                                                | Install the App on the repository, or give the machine's owner access to it.                                         |
| `run-unknown`          | The run has ended, went to another machine, or is in another repository.                                                                                                                                     | Start the work again.                                                                                                |

## Without a key

- A connector that speaks protocol 7 gets `no-grant`, and its builds,
  investigations, prototypes and Planner don't start.
- An older connector still gets its owner's own GitHub token and pushes as that
  person, for one more release. The server logs each such token:
  `chopin: legacy GitHub token for machine <machine-id> in octo-org/score: its connector predates App installation tokens`.
- Under `AUTH_MODE=local`, the server gives machines no GitHub token at all, with
  or without a key.

Set the key before people update `chopin`.

## Rotate the key

The App can hold up to 25 keys at once, so add the new key before removing the
old one.

1. Generate a new key: steps 4 to 6 of [Set it up](#set-it-up), replacing
   `/etc/chopin/github-app.pem`.
2. Restart Chopin. With Docker, start a new container, so it mounts the new
   file.
3. [Check it works](#check-it-works).
4. On the App's settings, click **Credentials**, then **Key pairs**. Click
   **Delete** next to the old key's fingerprint, and confirm.

If a key leaked, do the same now. Once you delete it, nobody can mint new tokens
with it. A token it already minted expires within an hour.

## What a Build's pull request looks like

- The pull request and its commits are by the bot, `<slug>[bot]`, with the email
  `<bot-id>+<slug>[bot]@users.noreply.github.com`.
- The pull request body ends with a line like
  `Requested by @mona in https://chopin.example/... Built by a coding agent with Chopin's GitHub App.`
- A review is requested from the person who started the Build.
- Every commit message ends with a trailer that credits them, so GitHub shows
  them as a co-author:
  `Co-authored-by: Mona Lisa <583231+mona@users.noreply.github.com>`.

Chopin tells the coding agent to add the last three. If one is missing, the
agent left it out.

# effect-cqrs on Google Cloud KMS

A runnable example of the master key from
[On Google Cloud KMS](https://davidnussio.github.io/effect-cqrs/guides/personal-data/#on-google-cloud-kms),
in the personal data guide of [effect-cqrs](https://github.com/davidnussio/effect-cqrs). The
personal fields of events are encrypted with a key per subject, and each subject's key is
stored wrapped by a symmetric key in Cloud KMS, which never leaves Google.

- `src/kms.ts`: the master key on Cloud KMS, the same code as the guide.
- `src/domain.ts`: a `customer` aggregate whose name and email are personal data.
- `src/main.ts`: the `register`, `show`, `forget` and `demo` commands.

Events and subject keys are kept in `data.sqlite`. Each command is a new process, so `show`
has to ask Cloud KMS to unwrap the subject's key. Every command prints what the database holds
and how many times it called the master key.

`effect-cqrs-0.3.0.tgz` is effect-cqrs 0.3.0 packed from its `main` branch, until that
version is on npm.

## Without Google

```bash
npm install
MASTER_KEY=local npm run demo
```

With `MASTER_KEY=local` the master key is a random key in memory. The demo registers a
customer, reads it back and forgets it in one process. "In the database" shows the encrypted
fields (`$personal`) and the subject's key, wrapped by `ephemeral`.

## 1. Set up Google Cloud

You need a project with billing enabled. The variables hold for the current shell; in fish,
write `set -x NAME value` instead of `export NAME=value`.

```bash
export PROJECT=$(gcloud config get-value project)
export LOCATION=europe-west6
```

Credentials for the client libraries, Application Default Credentials, with your account:

```bash
gcloud auth application-default login
```

Enable the API, and create a key ring with a symmetric key:

```bash
gcloud services enable cloudkms.googleapis.com --project "$PROJECT"
gcloud kms keyrings create effect-cqrs-test --location "$LOCATION" --project "$PROJECT"
gcloud kms keys create personal-data --keyring effect-cqrs-test --location "$LOCATION" --purpose encryption --project "$PROJECT"
```

The program reads the key's name from `PERSONAL_DATA_KMS_KEY`:

```bash
export PERSONAL_DATA_KMS_KEY="projects/$PROJECT/locations/$LOCATION/keyRings/effect-cqrs-test/cryptoKeys/personal-data"
```

If calls fail over quota or a missing project, set the project of the credentials:

```bash
gcloud auth application-default set-quota-project "$PROJECT"
```

As the project's owner you may already encrypt and decrypt. In production, a service account
with `roles/cloudkms.cryptoKeyEncrypterDecrypter` on that key alone is enough.

## 2. Encrypt and read back

```bash
npm run register -- alice "Alice Rossi" alice@example.com IT
```

Expected: `wrap 1, unwrap 0`. In the database, the key of `alice` is wrapped by the full name
of the KMS key.

```bash
npm run show -- alice
```

Expected: the state with the name and email in plain text, and `wrap 0, unwrap 1`. It is a new
process, so the key of `alice` comes from Cloud KMS.

## 3. Rotation

Create a new version of the key and make it the primary one:

```bash
gcloud kms keys versions create --key personal-data --keyring effect-cqrs-test --location "$LOCATION" --primary --project "$PROJECT"
npm run show -- alice
npm run register -- bob "Bob Bianchi" bob@example.com CH
```

Expected: `alice` still reads, because `decrypt` uses the version her key was wrapped with.
`bob` is wrapped with version 2. Both are wrapped by the same key name: nothing changes in the
database.

## 4. A disabled version

```bash
gcloud kms keys versions disable 1 --key personal-data --keyring effect-cqrs-test --location "$LOCATION" --project "$PROJECT"
npm run show -- alice
npm run show -- bob
```

Expected: `alice` fails with `PersonalDataError` ("Cloud KMS call failed"), and `bob` reads.
Disabling a version makes every subject wrapped with it unreadable. Enable it again:

```bash
gcloud kms keys versions enable 1 --key personal-data --keyring effect-cqrs-test --location "$LOCATION" --project "$PROJECT"
```

## 5. Swapped keys (optional)

A subject's key is bound to the subject. Copy the wrapped key of `bob` onto `alice`:

```bash
sqlite3 data.sqlite "UPDATE cqrs_personal_data_keys SET wrapped = (SELECT wrapped FROM cqrs_personal_data_keys WHERE subject = 'bob') WHERE subject = 'alice'"
npm run show -- alice
```

Expected: `PersonalDataError`, because Cloud KMS refuses to decrypt with a context, subject and
key id, other than the one it encrypted with. After this `alice` can't be read any more: start
again with `npm run reset`.

## 6. Forget

```bash
npm run forget -- bob
```

Expected: the name and email of `bob` read as `[forgotten]` and `forgotten@example.invalid`, and
his key shows as destroyed. The events in the database don't change, and Cloud KMS isn't called.

## Costs and cleanup

Cloud KMS bills each active key version, a few cents a month, and operations, a few cents per
10,000. Current prices are on https://cloud.google.com/kms/pricing.

Key rings and keys can't be deleted: you destroy their versions, which then cost nothing.
Destruction happens after the key's waiting period, 30 days by default.

```bash
gcloud kms keys versions destroy 1 --key personal-data --keyring effect-cqrs-test --location "$LOCATION" --project "$PROJECT"
gcloud kms keys versions destroy 2 --key personal-data --keyring effect-cqrs-test --location "$LOCATION" --project "$PROJECT"
npm run reset
```

To drop the local credentials: `gcloud auth application-default revoke`.

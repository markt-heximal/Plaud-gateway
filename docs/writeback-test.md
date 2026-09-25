# Write-back test: does a plaud-api speaker rename do what we need?

ADR 7, stage 3, step 1. **One throwaway recording, on your Mac, about 20
minutes.** Nothing gets built until this test says it's safe.

## What we're finding out

1. **Does the new name appear where you look?** The Plaud app shows the
   *cleaned-up* transcript, but plaud-api (reviewed at commit `076daf7`) only
   edits the *raw* one (`trans_result`).
2. **Does anything else change?** plaud-api uploads the whole raw transcript
   back over the original. We check that only the speaker name moved: every
   word and timestamp must be identical.

## Rules

- **Use only the throwaway recording from step 1.** Never a real meeting.
- Your Plaud Web token gives **full access** to your account. It only ever
  goes into this one terminal window, never into a file or a chat, and you
  sign out of Plaud Web at the end.
- The gateway side only reads, through Plaud's official connector.

## You need

- The stage 1 sign-in done (`npm start -- auth` in `~/projects/plaud-gateway`),
  with `PLAUD_STATE_DIR` pointing at the same folder.
- Python 3.10 or newer (`python3 --version`).

```bash
cd ~/projects/plaud-gateway && git pull
export PLAUD_STATE_DIR=~/stack/state/plaud
alias wbt='node --disable-warning=ExperimentalWarning tools/writeback-test.ts'
```

## Steps

**1. Make the test recording.** Record about 20 seconds of yourself talking,
in the Plaud app or on the device. Let it upload and transcribe. Open it in
the app and wait until the transcript shows **"Transcript cleaned up"**, so
both versions exist. Leave the speaker as **Speaker 1**.

**2. Find its ID.**

```bash
wbt latest
```

It's the newest line: `of_…`, today's time, about 20s. Keep the ID:

```bash
ID=of_xxxxxxxx
```

**3. Snapshot before.**

```bash
wbt snapshot $ID before.json
```

You should see both `transaction` (raw) and `transaction_polish`
(cleaned-up) with `speakers: Speaker 1`. If `transaction_polish` says
`none`, wait a few minutes, reopen the recording in the app, and repeat.

**4. Install plaud-api in a throwaway folder, pinned to the reviewed commit.**

```bash
python3 -m venv /tmp/plaud-api-test
/tmp/plaud-api-test/bin/pip install -q "git+https://github.com/arbuzmell/plaud-api@076daf7"
alias plaud=/tmp/plaud-api-test/bin/plaud
```

**5. Get your Plaud Web token** by following plaud-api's guide for your
browser:
[Chrome](https://github.com/arbuzmell/plaud-api/blob/076daf7/docs/token-chrome.md),
[Safari](https://github.com/arbuzmell/plaud-api/blob/076daf7/docs/token-safari.md) or
[Firefox](https://github.com/arbuzmell/plaud-api/blob/076daf7/docs/token-firefox.md).
Copy only the token, the part after `bearer `. Then paste it here; nothing
is shown as you type:

```bash
read -rs PLAUD_TOKEN && export PLAUD_TOKEN && echo "token set (${#PLAUD_TOKEN} characters)"
```

**6. Check, then rename.**

```bash
plaud speakers recording $ID                                # expect: Speaker 1
plaud speakers rename $ID "Speaker 1" "Writeback Test"
```

**7. Look in the Plaud app.** Wait a minute, then reopen the recording on your
phone and in Plaud Web. Note what each shows:
- the **cleaned-up transcript** (the default view): Speaker 1, or Writeback Test?
- the **original transcript**, if the app offers it: Speaker 1, or Writeback Test?

**8. Snapshot after, and compare.**

```bash
wbt snapshot $ID after.json
wbt compare before.json after.json
```

**9. Put it back, and check it's back.**

```bash
plaud speakers rename $ID "Writeback Test" "Speaker 1"
wbt snapshot $ID restored.json
wbt compare before.json restored.json
```

**10. Clean up.**

```bash
unset PLAUD_TOKEN
rm -rf /tmp/plaud-api-test before.json after.json restored.json
```

Then **sign out of Plaud Web** in that browser, which ends the session the
token came from. Delete the test recording in the Plaud app if you like.

## Send back these results

| | Result |
|---|---|
| Step 7, cleaned-up view in the app | Speaker 1 / Writeback Test |
| Step 7, original view (if shown) | Speaker 1 / Writeback Test / not shown |
| Step 8, `transaction` line | e.g. `only the speaker changed: Speaker 1 -> Writeback Test` |
| Step 8, `transaction_polish` line | e.g. `unchanged` |
| Step 9, both lines | `unchanged` expected |
| Anything odd | errors, warnings, the app looking different |

## What the results mean

- **The cleaned-up view shows "Writeback Test", and step 8 says "only the
  speaker changed" (or "unchanged") for both blocks.** Write-back works. I
  build the writer with these guards:
  - a full backup of the transcript before every change;
  - it uploads only if the speaker name is the sole difference;
  - no automatic retries;
  - every change confirmed through the official connector.
- **The cleaned-up view still says "Speaker 1".** The rename never reaches
  where you look. We drop write-back: fixes stay in coach4me and the gateway,
  and we ask Plaud for renames in its official connector.
- **Any line says "CHANGED BEYOND THE RENAME", "APPEARED" or "DISAPPEARED".**
  Stop. The rename damaged or rewrote more than the name, so write-back is off
  the table with this client. Step 9 shows whether it was put back.

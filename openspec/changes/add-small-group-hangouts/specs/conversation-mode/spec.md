# Conversation Mode

## Purpose

Coordinate host-controlled changes between studio and hangout audio without confusing conversation state with recording state or the availability of saved audio.

## ADDED Requirements

### Requirement: Explicit host-controlled mode changes

Only an authenticated host SHALL initiate Move to hangout, Return to studio, or End conversation. Stop and Finish SHALL retain their existing recording semantics and SHALL NOT automatically change the conversation mode.

#### Scenario: Recording stops

- **WHEN** the host stops or finishes a recording
- **THEN** participants remain on the current conversation transport until a separate host action
- **AND** no elapsed recording duration automatically ends the room

#### Scenario: A guest requests a room-wide change

- **WHEN** a guest attempts a room-wide mode change or end action
- **THEN** the request is rejected and the current mode is preserved

### Requirement: Recording and transitions are mutually exclusive

Move to hangout and End conversation SHALL be rejected while a recording is starting or active. Recording start SHALL be rejected during a transition or in hangout or ended mode. Clients SHALL confirm that their local recorders have stopped before acknowledging Move to hangout or End conversation.

#### Scenario: Record and Move to hangout race

- **WHEN** recording start and Move to hangout are requested concurrently
- **THEN** at most one is accepted
- **AND** the rejected request receives the current state without starting a second operation

#### Scenario: A guest is still stopping its recorder

- **WHEN** the server has stopped a take but a guest has not completed local recorder shutdown
- **THEN** the room does not commit its hangout transition until that guest acknowledges its recorder has stopped
- **AND** preparation times out if the acknowledgement never arrives

#### Scenario: End is requested before a guest finishes stopping

- **WHEN** the server take is stopped but a connected guest's recorder has not finished stopping
- **THEN** End conversation waits for that guest's stopped acknowledgement
- **AND** missing acknowledgement cancels the end operation at its deadline while preserving the source conversation

### Requirement: Recording assets survive conversation changes

Moving, returning, leaving audio, or ending the conversation SHALL preserve local backups, pending uploads, upload authorization, progress, and recovery actions. Conversation controls SHALL NOT finalize, purge, or mark an asset uploaded.

#### Scenario: Upload continues during a handoff

- **WHEN** a stopped take is still uploading during Move to hangout
- **THEN** its upload continues with the same ownership and progress
- **AND** the hangout action does not erase the recovery copy or claim upload completion

#### Scenario: The host ends audio while an upload has failed

- **WHEN** End conversation succeeds while a participant has a failed upload
- **THEN** audio closes while that participant retains the backup and retry interface

### Requirement: Bounded preparation with one audible path

A transition SHALL prepare the target transport for every member of its admitted participant snapshot before committing. Preparation SHALL have a finite deadline. Before commit, failure SHALL preserve the original mode and release prepared resources. Each client SHALL play at most one transport's remote audio.

#### Scenario: One participant cannot prepare

- **WHEN** any required participant fails target readiness before the preparation deadline
- **THEN** the operation is cancelled, the original conversation remains selected, and the failure identifies the affected participant
- **AND** prepared target connections are released

#### Scenario: Preparation succeeds

- **WHEN** all required participants report target readiness for the same operation
- **THEN** the authoritative mode is committed and clients switch their audible transport
- **AND** the UI does not promise a physically simultaneous or interruption-free switch

### Requirement: Authoritative mode and stale-message rejection

Every mode change SHALL have a persistent generation and operation identity. Joins and reconnects SHALL reconcile to the committed mode. Stale events and retries SHALL NOT reverse a later operation or implicitly start a recording.

#### Scenario: A client misses the commit event

- **WHEN** that client reconnects after the server committed hangout
- **THEN** it reads the committed generation and joins hangout instead of reconnecting to the old studio mode

#### Scenario: A participant arrives during preparation

- **WHEN** a new participant joins while a transition is preparing
- **THEN** the participant waits for the operation to resolve before joining the resulting mode
- **AND** the existing readiness snapshot does not silently change

#### Scenario: Membership changes during preparation

- **WHEN** a required participant leaves, refreshes, replaces a duplicate connection, or loses contact before commit
- **THEN** the operation cancels and the host can retry with a fresh participant snapshot

### Requirement: Confirmed LiveKit cleanup

A successful audio switch SHALL be distinguished from verified LiveKit cleanup. The system SHALL stop fresh studio admission for a committed hangout, disconnect old participants, prevent reuse of their eligible old tokens in the supported cloud deployment, and retry failed cleanup.

#### Scenario: Audio works but cleanup fails

- **WHEN** hangout audio is active and LiveKit cleanup has not been confirmed
- **THEN** the UI reports that studio cleanup is pending and minutes may still accrue
- **AND** cleanup is retried idempotently without restarting recording or moving the call back automatically

#### Scenario: An old token is reused

- **WHEN** an original or SDK-refreshed token from the retired studio connection is replayed after confirmed cleanup
- **THEN** it cannot reconnect that participant to the retired cloud room

#### Scenario: Retired cleanup finishes after a later return

- **WHEN** a delayed cleanup request for an old studio connection runs after participants return to studio
- **THEN** it cannot disconnect or revoke their newer studio connections
- **AND** cleanup status continues to identify the retired connection it concerns

### Requirement: Explicit return without automatic recording

Return to studio SHALL prepare and commit LiveKit connectivity before enabling a separate Record action. A failed return SHALL preserve hangout. A finalized session SHALL retain its existing prohibition on new takes.

#### Scenario: The host returns for another take

- **WHEN** Return to studio completes for an unfinalized session
- **THEN** the recorder is idle and the host can separately request Record after readiness checks

#### Scenario: LiveKit rejects the return

- **WHEN** LiveKit admission fails, including quota exhaustion
- **THEN** the room remains in hangout and displays the provider failure

#### Scenario: The session was finalized

- **WHEN** the host requests recording after finalization
- **THEN** the existing new-session requirement is shown
- **AND** returning to studio does not reopen or overwrite the finalized session

### Requirement: Ending and individual departure

End conversation SHALL persist an ended state, close first-party audio connections, and deny new conversation admission. Individual Leave or host disconnection SHALL NOT end other participants' stable hangout. An ended conversation SHALL NOT reopen within this pilot.

#### Scenario: The host ends a nonrecording hangout

- **WHEN** the host selects End conversation
- **THEN** connected first-party clients stop conversation audio and future joins are denied
- **AND** a client that missed the event observes ended state on reconciliation

#### Scenario: The host leaves without ending

- **WHEN** the host leaves a stable hangout with other participants connected
- **THEN** those participants can continue talking
- **AND** nobody is silently promoted to host

### Requirement: Calls have no automatic duration cutoff

The pilot SHALL NOT automatically terminate a connected hangout based on call age, silence, or time since recording stopped. Cleanup of an empty room SHALL NOT be interpreted as a maximum duration for an occupied room.

#### Scenario: A long silent hangout resumes

- **WHEN** participants remain connected beyond thirty minutes without recording or speaking
- **THEN** the application does not end their call for inactivity
- **AND** participants can resume speaking subject to network and authorization availability

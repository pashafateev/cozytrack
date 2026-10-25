# Hangout Audio

## Purpose

Let small groups continue an audio conversation without retaining a LiveKit connection, while preserving recording assets and exposing connection and operating-cost evidence.

## ADDED Requirements

### Requirement: Small-group conversational audio

An enabled hangout SHALL provide bidirectional audio, participant identity, microphone mute, individual Leave, and connection status for up to four authenticated participants. A lone participant SHALL be allowed to wait. The pilot SHALL be audio-only.

#### Scenario: Two through four people talk

- **WHEN** two, three, or four admitted participants enter hangout
- **THEN** each participant can hear every other unmuted participant
- **AND** muting or leaving affects that participant without ending the others' conversation

#### Scenario: Capacity is reached

- **WHEN** a fifth participant requests admission to a four-person hangout
- **THEN** admission is rejected with an explanation of the pilot capacity
- **AND** the existing conversation remains connected

#### Scenario: The existing studio exceeds pilot capacity

- **WHEN** the host requests Move to hangout with more than four studio participants
- **THEN** the transition is rejected with a capacity explanation
- **AND** nobody is evicted from the studio

### Requirement: Conversational mute survives transitions

The system SHALL preserve each participant's conversational microphone mute across preparation, commit, cancellation, and Return to studio. Preparing a target connection SHALL NOT publish microphone audio that the participant has muted.

#### Scenario: A muted participant changes modes

- **WHEN** a muted participant prepares a target connection or completes or cancels a transition
- **THEN** the microphone remains muted on every conversational publication
- **AND** the recording capture settings are unchanged

### Requirement: Direct audio with relay fallback

Hangout audio SHALL attempt direct peer connections and use an authorized relay when direct connectivity is unavailable. Relay selection SHALL NOT silently reconnect participants to LiveKit. The product SHALL disclose that direct connections can expose participants' public IP addresses to one another.

#### Scenario: A network blocks direct connectivity

- **WHEN** a participant cannot establish a direct path but an authorized relay path works
- **THEN** that participant joins the same hangout through the relay
- **AND** no LiveKit connection is opened as a side effect

#### Scenario: Both network paths fail

- **WHEN** neither direct nor relayed connectivity can be established
- **THEN** the affected connection is identified as failed with a retry action
- **AND** the room is not shown as fully connected

### Requirement: Session-scoped identity and credentials

Signaling and relay admission SHALL require current session-scoped authorization. Identity, role, room, and conversation generation SHALL be server-derived. Clients SHALL NOT receive long-term signing or relay secrets.

#### Scenario: A client attempts cross-room signaling

- **WHEN** a client submits a message or credential request for another room, identity, or stale generation
- **THEN** it is rejected without forwarding the message or issuing credentials

#### Scenario: A client impersonates the host

- **WHEN** guest-controlled message fields claim a host role
- **THEN** the service uses the authenticated guest role and rejects host-only operations

### Requirement: Long calls and recoverable connections

The system SHALL renew expiring connection credentials and support reconnection without imposing an application call-duration limit. Credential or network failures SHALL be visible and SHALL NOT clear recording data or upload state.

#### Scenario: Credentials approach expiry

- **WHEN** a long-running hangout approaches credential expiry and authorization remains valid
- **THEN** credentials are renewed before expiry and the connection remains usable or performs a visible reconnect

#### Scenario: Authorization can no longer be renewed

- **WHEN** a renewal is denied because authentication expired
- **THEN** the participant receives actionable reauthentication guidance
- **AND** local backups and pending upload state remain available

#### Scenario: A participant changes networks

- **WHEN** a network change breaks an established peer connection
- **THEN** the client attempts recovery for the current room generation
- **AND** reports failure if recovery is exhausted instead of remaining falsely connected

### Requirement: Cost and quality evidence

The pilot SHALL expose operator metrics for participant connection time, direct/relay selection, connection success and recovery, media traffic, and LiveKit cleanup status. Billing estimates SHALL identify their assumptions and be reconciled with provider usage.

#### Scenario: An operator evaluates the pilot

- **WHEN** the operator reviews a pilot reporting period
- **THEN** room-hours, participant-hours, relay traffic, connection failures, and cleanup failures are distinguishable
- **AND** codec payload bytes are not represented as a verified provider bill
- **AND** diagnostic records omit credentials, raw session descriptions, and raw network candidates

### Requirement: Disabled pilot preserves existing behavior

Hangout entry SHALL be disabled by default and available only in explicitly enabled pilot sessions. Disabling new pilot admissions SHALL NOT destroy an existing conversation, recording, or upload.

#### Scenario: The pilot is disabled

- **WHEN** a session has not been enabled for hangout
- **THEN** its existing LiveKit recording flow remains available without a hangout action

#### Scenario: New admissions are disabled during a call

- **WHEN** the operator disables the pilot while a hangout is active
- **THEN** existing participants retain Leave, End conversation, and Return to studio recovery paths
- **AND** the call is not silently terminated by the flag change

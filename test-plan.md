# Force Stop Agent Work - Test Plan

## Overview
This test plan verifies the functionality that allows users to stop agent work immediately when pressing the Escape key on the session page.

## Prerequisites
- Access to a deployed environment of the remote-swe-agents application
- A session with a running agent (agent status is "working")

## Test Cases

### 1. Force Stop via Escape Key
**Objective:** Verify that pressing the Escape key triggers the force stop functionality.

**Steps:**
1. Navigate to a session page with an active agent (status: "working")
2. Press the Escape key
3. Observe the confirmation dialog
4. Click "OK" to confirm

**Expected Results:**
- A confirmation dialog appears asking to confirm stopping the agent
- After confirming, a success toast message is displayed
- Agent status changes from "working" to "pending"
- Any ongoing agent work stops immediately
- A system message appears: "Agent work was force stopped by user."

### 2. Cancel Force Stop Action
**Objective:** Verify that the force stop action can be canceled.

**Steps:**
1. Navigate to a session page with an active agent (status: "working")
2. Press the Escape key
3. When the confirmation dialog appears, click "Cancel"

**Expected Results:**
- The confirmation dialog disappears
- No events are sent to the agent
- Agent continues working without interruption

### 3. Escape Key with Inactive Agent
**Objective:** Verify that the Escape key has no effect when agent is not working.

**Steps:**
1. Navigate to a session page where the agent status is "pending" or "completed"
2. Press the Escape key

**Expected Results:**
- No confirmation dialog appears
- No change in agent status or behavior

### 4. Network Error Handling
**Objective:** Verify error handling when the force stop request fails.

**Steps:**
1. Simulate a network error condition
2. Navigate to a session page with an active agent
3. Press the Escape key and confirm the dialog

**Expected Results:**
- An error toast message appears indicating the failure
- The agent continues working

### 5. Multiple Escape Key Presses
**Objective:** Verify system behavior when Escape key is pressed multiple times.

**Steps:**
1. Navigate to a session page with an active agent
2. Press the Escape key and confirm the dialog
3. After agent status changes to "pending", press the Escape key again

**Expected Results:**
- First press: Force stop is triggered and completes successfully
- Second press: No confirmation dialog appears (as agent is no longer working)

## Non-Functional Requirements
- Performance: The force stop action should be processed within 2 seconds
- Usability: The confirmation dialog should be clear about the action being taken
- Reliability: The force stop functionality should work consistently across different browsers
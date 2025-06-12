# Remote SWE Agents HTTP API

This directory contains the HTTP API endpoints for the Remote SWE Agents application. The API allows external services to create and interact with agent sessions.

## Authentication

All API endpoints require authentication using an API key. The API key must be included in the `Authorization` header as a Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

API keys can be managed through the web UI at `/settings/api-keys`.

## Available Endpoints

### Create a new session

Creates a new agent session with an initial message.

**Endpoint**: `POST /api/sessions/`

**Request Body**:
```json
{
  "message": "Your initial message to the agent"
}
```

**Response**:
```json
{
  "workerId": "api-1234567890"
}
```

The `workerId` is used to identify the session in subsequent requests.

### Send message to a session

Sends a follow-up message to an existing session.

**Endpoint**: `POST /api/sessions/:sessionId`

**Request Body**:
```json
{
  "message": "Your follow-up message to the agent"
}
```

**Response**:
```json
{
  "success": true
}
```

Replace `:sessionId` with the `workerId` returned when creating the session.

## Error Responses

All API endpoints return appropriate HTTP status codes:

- `200/201` - Request successful
- `400` - Bad request (invalid input)
- `401` - Unauthorized (missing or invalid API key)
- `404` - Resource not found
- `500` - Server error

Error responses include a JSON body with an error message:

```json
{
  "error": "Error message"
}
```

## Example Usage

### cURL

Create a new session:
```bash
curl -X POST \
  https://yourwebapp.com/api/sessions/ \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"message": "Create a React component for a user profile page"}'
```

Send a follow-up message:
```bash
curl -X POST \
  https://yourwebapp.com/api/sessions/api-1234567890 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"message": "Add dark mode support to the component"}'
```

### JavaScript

```javascript
// Create a new session
async function createSession(apiKey, message) {
  const response = await fetch('https://yourwebapp.com/api/sessions/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ message })
  });
  return response.json();
}

// Send a message to an existing session
async function sendMessage(apiKey, sessionId, message) {
  const response = await fetch(`https://yourwebapp.com/api/sessions/${sessionId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ message })
  });
  return response.json();
}
```
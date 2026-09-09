# GridLink — SecondLife Communicator (Mobile MVP)

## Overview
A Firestorm-inspired mobile companion for Second Life. Login runs the real
XML-RPC handshake against `login.agni.lindenlab.com` / `login.aditi.lindenlab.com`
using the libremetaverse/Firestorm-standard struct (channel, version, mac,
id0, `$1$`+MD5 password, options[]) so friends and inventory come straight
from the grid's `buddy-list` and `inventory-skeleton`. Offline mode lets you
pick an avatar name and drive the same UI against seeded local data.

## Features
- Grid login (Agni/Aditi) via real XML-RPC + Offline demo mode
- **Live sim circuit (LLUDP)** opened after grid login (`sl_circuit.py`):
  UseCircuitCode → CompleteAgentMovement → AgentUpdate keep-alives; handles
  OnlineNotification/OfflineNotification (presence), AgentGroupDataUpdate
  (group roster, UDP + EventQueueGet), ChatFromSimulator (local chat in),
  ImprovedInstantMessage (IMs, group chat, friendship offers/accepts);
  sends ChatFromViewer / IM / group SessionSend / FriendshipOffered.
- Chat tab with Local/IM/Group segmented sub-tabs, monospace bubbles,
  timestamps, keyboard-avoiding compose bar, LINK badge (circuit state),
  4s polling of the active channel. IM chips = online friends + IM history;
  Group chips = real groups; "ALL (n)" chip opens a searchable ScopePicker.
- Friends tab with live online-status (30s presence poll), All/Online
  filter, rights icons, tap → IM that friend, account-plus → resident search,
  FRIENDSHIP OFFERS cards (ACCEPT sends AcceptFriendship, DECLINE sends
  DeclineFriendship over the circuit)
- Unread badges: `src/unread.ts` store polls `/api/chat/unread` every 8s →
  CHAT tab badge, IM/GROUP segment badges, per-chip badges; viewing a scope
  posts `/api/chat/mark_read`
- Radar screen: live avatars in the region from CoarseLocationUpdate
  (distance, bearing, friend flag, tap → IM), 5s poll
- Reconnect: LINK badge (Chat) / RECONNECT TO GRID (More) call
  `POST /api/reconnect` which re-runs the login with the stored `$1$md5`
  hash, keeps session_id + chat history, restarts the circuit
- Search screen: AvatarPickerSearch cap (grid) / mock directory (offline),
  ADD sends a FriendshipOffered IM over the circuit
- Inventory tab with hierarchical folder tree, expand/collapse, per-type icons
- More tab: session detail card (incl. sim link state) + Diagnostics, Radar,
  Settings, Disconnect (sends LogoutRequest)
- Diagnostics screen: DNS, TCP/TLS reachability, XML-RPC latency gauge with
  color-coded thresholds (green <100ms, yellow <300ms, red ≥300ms)

## Tech
- Frontend: Expo Router 57, React Native 0.86, `@react-native-vector-icons/material-design-icons`, expo-image, expo-linear-gradient, expo-haptics, react-query, AsyncStorage
- Backend: FastAPI + Motor, Python `xmlrpc.client` for the SL login endpoint
- Theme: `#050810` navy surfaces, `#00F0FF` cyan brand, `#B026FF` violet secondary, monospace chat

## Endpoints
- `POST /api/login/grid`, `POST /api/login/offline`, `POST /api/logout`
- `GET /api/session`, `/api/status` (circuit state), `/api/friends`, `/api/groups`, `/api/inventory`
- `GET /api/im/conversations`, `GET /api/search/residents?q=`, `POST /api/friends/request`, `POST /api/friends/refresh_names`
- `GET /api/friends/requests`, `POST /api/friends/requests/{id}/accept|decline`, `GET /api/radar`, `GET /api/chat/unread`, `POST /api/chat/mark_read`, `POST /api/reconnect`
- `GET /api/chat?session_id&channel&scope` (scope = "local" | agent UUID | group UUID), `POST /api/chat/send`
- `GET /api/diagnostics?grid=agni|aditi`, `GET /api/grids`

## Notes / Constraints
- Grid sessions live in the backend process (`CIRCUITS` dict + UDP thread).
  A backend restart drops the circuit; `/api/status` then reports
  `no circuit` and the user must log in again. SL allows one circuit per
  avatar, so always logout before re-logging.
- Test account (grid): see `/app/memory/test_credentials.md`.

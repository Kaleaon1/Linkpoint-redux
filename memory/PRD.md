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
- Chat tab with Local/IM/Group segmented sub-tabs, monospace bubbles,
  timestamps, per-scope chip row, keyboard-avoiding compose bar
- Friends tab with online-status dots, All/Online filter, rights icons
  (see-online / see-map / modify-objects)
- Inventory tab with hierarchical folder tree, expand/collapse, per-type
  icons (textures, clothing, scripts, notecards, landmarks…)
- More tab: session detail card + Diagnostics, Radar, Settings, Disconnect
- Diagnostics screen: DNS, TCP/TLS reachability, XML-RPC latency gauge with
  color-coded thresholds (green <100ms, yellow <300ms, red ≥300ms)

## Tech
- Frontend: Expo Router 57, React Native 0.86, `@react-native-vector-icons/material-design-icons`, expo-image, expo-linear-gradient, expo-haptics, react-query, AsyncStorage
- Backend: FastAPI + Motor, Python `xmlrpc.client` for the SL login endpoint
- Theme: `#050810` navy surfaces, `#00F0FF` cyan brand, `#B026FF` violet secondary, monospace chat

## Endpoints
- `POST /api/login/grid`, `POST /api/login/offline`, `POST /api/logout`
- `GET /api/session`, `/api/friends`, `/api/inventory`
- `GET /api/chat?session_id&channel&scope`, `POST /api/chat/send`
- `GET /api/diagnostics?grid=agni|aditi`, `GET /api/grids`

## Notes / Constraints
- Full sim UDP messaging (LLUDP) is not feasible in a mobile preview, so
  once logged in, chat/IM/group messages are stored per-session in Mongo
  and rendered with the authenticated avatar as sender. Grid presence,
  friends and inventory folders are still real data pulled from the login
  response. This matches how a lightweight mobile companion (vs. a full
  viewer like Firestorm/Radegast) typically behaves.

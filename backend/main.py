from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import Dict, List, Optional, Any
from pydantic import BaseModel
import json

app = FastAPI()

# room_id -> list of websockets
rooms: Dict[str, List[WebSocket]] = {}

# Pydantic models for validation (optional, but good for structure)
# We can't easily valid exact types at runtime with just JSON, but we can try parsing.
# For now, we will handle them as Generic payloads but with explicitly supported types.
class BaseMessage(BaseModel):
    type: str
    sender: Optional[str] = None

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str):
    await ws.accept()

    if room_id not in rooms:
        rooms[room_id] = []

    rooms[room_id].append(ws)
    
    print(f"Client connected to room {room_id}. Total clients: {len(rooms[room_id])}")

    try:
        while True:
            data = await ws.receive_json()
            
            # Basic validation check
            message_type = data.get("type")
            
            if message_type in ["chat", "image", "file"]:
                print(f"[{room_id}] Received {message_type} from {data.get('sender', 'Unknown')}")
            elif message_type in ["offer", "answer", "ice"]:
                 # Signaling logs (less verbose usually, but good for debug)
                 # print(f"[{room_id}] Signal: {message_type}")
                 pass
            else:
                 print(f"[{room_id}] Unknown message type: {message_type}")

            # broadcast to others in room
            for client in rooms[room_id]:
                if client != ws:
                    await client.send_json(data)

    except WebSocketDisconnect:
        rooms[room_id].remove(ws)
        print(f"Client disconnected from room {room_id}")
        if not rooms[room_id]:
            del rooms[room_id]

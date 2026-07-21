const WebSocket = require('ws');

const SERVER_URL = 'ws://101.37.80.51:8080';

async function testRemoteControl() {
  console.log('=== Testing Remote Control Protocol ===\n');
  
  const ws = new WebSocket(SERVER_URL);
  
  ws.on('open', () => {
    console.log('Connected to server');
    
    ws.send(JSON.stringify({ type: 'REGISTER' }));
  });
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'REGISTER_SUCCESS': {
          console.log(`✓ Registered with device ID: ${data.deviceId}`);
          
          console.log('\n1. Testing CREATE_SESSION...');
          ws.send(JSON.stringify({ type: 'CREATE_SESSION' }));
          break;
        }
        
        case 'SESSION_CREATED': {
          console.log(`✓ Session created: ${data.sessionId}`);
          console.log(`✓ Session token: ${data.sessionToken}`);
          
          console.log('\n2. Testing INPUT_EVENT forwarding...');
          ws.send(JSON.stringify({
            type: 'INPUT_EVENT',
            targetId: data.deviceId,
            event: {
              type: 'mouse-move',
              x: 500,
              y: 300
            },
            sessionId: data.sessionId
          }));
          
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'INPUT_EVENT',
              targetId: data.deviceId,
              event: {
                type: 'mouse-down',
                x: 500,
                y: 300,
                button: 'left'
              },
              sessionId: data.sessionId
            }));
            
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'INPUT_EVENT',
                targetId: data.deviceId,
                event: {
                  type: 'mouse-up',
                  x: 500,
                  y: 300,
                  button: 'left'
                },
                sessionId: data.sessionId
              }));
              
              setTimeout(() => {
                console.log('\n✓ All input events sent successfully');
                console.log('\n=== Test Complete ===');
                ws.close();
              }, 500);
            }, 200);
          }, 200);
          break;
        }
        
        case 'INPUT_EVENT': {
          console.log(`✓ Received INPUT_EVENT on target device:`);
          console.log(`  Type: ${data.event.type}`);
          if (data.event.x !== undefined) {
            console.log(`  Position: (${data.event.x}, ${data.event.y})`);
          }
          if (data.event.button) {
            console.log(`  Button: ${data.event.button}`);
          }
          break;
        }
        
        default:
          console.log(`Received: ${data.type}`);
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log('\nDisconnected from server');
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
}

testRemoteControl();
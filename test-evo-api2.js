const axios = require('axios');
axios.get("https://n8n-evolution-api.REDACTED.easypanel.host/instance/fetchInstances?instanceName=TESTE", {
  headers: { "apikey": "REDACTED" },
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
}).then(res => {
  console.log(JSON.stringify(res.data, null, 2));
}).catch(err => {
  console.error(err.response ? err.response.data : err.message);
});

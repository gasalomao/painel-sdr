const axios = require('axios');
axios.get("https://n8n-evolution-api.sfrto8.easypanel.host/instance/fetchInstances?instanceName=TESTE", {
  headers: { "apikey": "429683C4C977415CAAFCCE10F7D57E11" },
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
}).then(res => {
  console.log(JSON.stringify(res.data, null, 2));
}).catch(err => {
  console.error(err.response ? err.response.data : err.message);
});

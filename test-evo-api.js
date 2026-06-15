const axios = require('axios');
axios.get("https://n8n-evolution-api.REDACTED.easypanel.host/instance/fetchInstances", {
  headers: { "apikey": "REDACTED" },
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
}).then(res => {
  const data = res.data;
  data.forEach(inst => {
    console.log(
      "Name:", inst.name,
      "| Owner:", inst.owner,
      "| Number:", inst.number,
      "| Profile:", inst.profile?.name, inst.profile?.number, inst.profileName
    );
  });
}).catch(err => {
  console.error(err.response ? err.response.data : err.message);
});

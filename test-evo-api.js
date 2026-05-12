const axios = require('axios');
axios.get("https://n8n-evolution-api.sfrto8.easypanel.host/instance/fetchInstances", {
  headers: { "apikey": "429683C4C977415CAAFCCE10F7D57E11" },
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

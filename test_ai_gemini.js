const axios = require('axios');

async function testAIEndpoints() {
  console.log('Testing AI Product SEO endpoint with gemini-3.6-flash...');
  try {
    const res1 = await axios.post('http://localhost:5000/api/ai/generate-title', {
      productName: 'Setelan Wanita Casual Kekinian FS41'
    });
    console.log('1. Product Title SEO Output:', JSON.stringify(res1.data, null, 2));
  } catch (e) {
    console.error('Error 1:', e.message);
  }

  console.log('\nTesting AI Store CS & Copywriting endpoint with gemini-3.6-flash...');
  try {
    const res2 = await axios.post('http://localhost:5000/api/ai/generate-store-copy', {
      storeName: 'Toko Real Shopee'
    });
    console.log('2. Store CS Copywriting Output:', JSON.stringify(res2.data, null, 2));
  } catch (e) {
    console.error('Error 2:', e.message);
  }

  console.log('\nTesting AI Ads Keyword Bids endpoint with gemini-3.6-flash...');
  try {
    const res3 = await axios.post('http://localhost:5000/api/ai/generate-ads-keywords', {
      campaignName: 'Setelan Women FS41'
    });
    console.log('3. Ads Keywords Output:', JSON.stringify(res3.data, null, 2));
  } catch (e) {
    console.error('Error 3:', e.message);
  }
}

testAIEndpoints();

export default {
	async fetch(request, env, ctx) {
	  // Define CORS headers
	  const corsHeaders = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
	  };
  
	  // Handle OPTIONS requests for CORS preflight
	  if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders, status: 204 });
	  }
  
	  console.log(`Received ${request.method} request to ${request.url}`);
  
	  try {
		// Try to get cached data from KV
		const cachedData = await env.SNOWFALL_CACHE.get('snowData', { type: 'json' });
		const cacheTimestamp = await env.SNOWFALL_CACHE.get('timestamp');
  
		if (cachedData && cacheTimestamp) {
		  const cacheAge = Date.now() - parseInt(cacheTimestamp);
		  if (cacheAge < config.cacheTime * 1000) {
			console.log(`Using cached data from ${new Date(parseInt(cacheTimestamp)).toISOString()}`);
			return new Response(JSON.stringify(cachedData), {
			  headers: {
				'Content-Type': 'application/json',
				'Cache-Control': `max-age=${config.cacheTime}`,
				...corsHeaders,
			  },
			});
		  } else {
			console.log('Cache expired, fetching fresh data');
		  }
		} else {
		  console.log('No cache found, fetching data from NOAA');
		}
  
		// Calculate the current date as endDate
		const endDate = new Date().toISOString().split('T')[0];
  
		// Retrieve your NOAA token from the environment
		const token = env.NOAA_API_TOKEN;
		if (!token) throw new Error('NOAA_API_TOKEN is not defined in the environment');
  
		console.log(`Fetching data from ${config.startDate} to ${endDate}`);
		const data = await fetchAllData(config.startDate, endDate, token);
  
		console.log(`Caching ${data.length} records`);
		await env.SNOWFALL_CACHE.put('snowData', JSON.stringify(data), { expirationTtl: config.cacheTime });
		await env.SNOWFALL_CACHE.put('timestamp', Date.now().toString(), { expirationTtl: config.cacheTime });
  
		return new Response(JSON.stringify(data), {
		  headers: {
			'Content-Type': 'application/json',
			'Cache-Control': `max-age=${config.cacheTime}`,
			...corsHeaders,
		  },
		});
	  } catch (error) {
		console.error(`Error processing request: ${error.message}`);
		console.error(error.stack);
		return new Response(
		  JSON.stringify({ error: error.message, timestamp: new Date().toISOString() }),
		  { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
		);
	  }
	}
  };
  
  // Configuration and state settings
  const config = {
	station: 'GHCND:USW00014755', // NOAA V2 station format
	dataTypes: ['SNOW', 'SNWD'],   // Data types to retrieve
	startDate: '1948-08-01',       // Historical start date
	baseURL: 'https://www.ncdc.noaa.gov/cdo-web/api/v2/data', // NOAA API endpoint
	chunkSize: 365,              // Days per chunk (using a larger chunk size on the server)
	retryCount: 3,               // Maximum retry attempts per chunk
	cacheTime: 86400,            // Cache lifetime in seconds (24 hours)
  };
  
  /**
   * Fetch data for all data types from NOAA API.
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} token - NOAA API token
   */
  async function fetchAllData(startDate, endDate, token) {
	const chunks = createDateChunks(startDate, endDate, config.chunkSize);
	const allResults = new Map();
  
	console.log(`Processing ${chunks.length} chunks for ${config.dataTypes.length} data types`);
  
	for (const dataType of config.dataTypes) {
	  for (const chunk of chunks) {
		console.log(`Fetching ${dataType} from ${chunk.start} to ${chunk.end}`);
		const results = await fetchDataChunk(dataType, chunk.start, chunk.end, token);
  
		for (const item of results) {
		  const date = item.date.split('T')[0];
		  if (!allResults.has(date)) {
			allResults.set(date, { DATE: date, SNOW: -9999, SNWD: -9999 });
		  }
		  const entry = allResults.get(date);
		  if (dataType === 'SNOW') {
			entry.SNOW = item.value;
		  } else if (dataType === 'SNWD') {
			entry.SNWD = item.value;
		  }
		}
		// Delay between chunks to reduce load and avoid rate-limiting
		await new Promise((resolve) => setTimeout(resolve, 500));
	  }
	}
  
	// Convert map to sorted array by date
	const combinedResults = Array.from(allResults.values());
	combinedResults.sort((a, b) => a.DATE.localeCompare(b.DATE));
  
	console.log(`Processed ${combinedResults.length} total records`);
	return combinedResults;
  }
  
  /**
   * Fetch data for a specific data type and date range with retries.
   * @param {string} dataType - NOAA data type (SNOW, SNWD)
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} token - NOAA API token from env
   * @param {number} retryCount - Current retry count (optional)
   */
  async function fetchDataChunk(dataType, startDate, endDate, token, retryCount = 0) {
	if (retryCount >= config.retryCount) {
	  console.error(`Maximum retry count (${config.retryCount}) exceeded for ${dataType} from ${startDate} to ${endDate}.`);
	  return [];
	}
  
	const url = new URL(config.baseURL);
	url.searchParams.set('datasetid', 'GHCND');
	url.searchParams.set('stationid', config.station);
	url.searchParams.set('datatypeid', dataType);
	url.searchParams.set('startdate', startDate);
	url.searchParams.set('enddate', endDate);
	url.searchParams.set('limit', 1000);
	url.searchParams.set('units', 'metric');
  
	try {
	  console.log(`Making request to ${url.toString()}`);
	  const response = await fetch(url, {
		method: 'GET',
		headers: {
		  'token': token,
		},
	  });
  
	  if (!response.ok) {
		const responseText = await response.text();
		console.error(`Error response ${response.status}: ${responseText}`);
  
		if ([429, 503, 403].includes(response.status)) {
		  const backoffTime = Math.min(15000, 2000 * Math.pow(1.5, retryCount));
		  console.log(`Rate limited (${response.status}). Waiting ${backoffTime}ms before retry ${retryCount + 1}...`);
		  await new Promise((resolve) => setTimeout(resolve, backoffTime));
		  return fetchDataChunk(dataType, startDate, endDate, token, retryCount + 1);
		}
		throw new Error(`HTTP error! status: ${response.status}`);
	  }
  
	  const data = await response.json();
	  console.log(`Received ${data?.results?.length || 0} ${dataType} records`);
	  return data && data.results ? data.results : [];
	} catch (error) {
	  console.error(`Error fetching ${dataType} from ${startDate} to ${endDate}:`, error);
	  const backoffTime = Math.min(15000, 2000 * Math.pow(1.5, retryCount));
	  console.log(`Network error. Waiting ${backoffTime}ms before retry ${retryCount + 1}...`);
	  await new Promise((resolve) => setTimeout(resolve, backoffTime));
	  return fetchDataChunk(dataType, startDate, endDate, token, retryCount + 1);
	}
  }
  
  /**
   * Create date chunks for processing.
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {number} chunkSizeDays - Number of days per chunk
   */
  function createDateChunks(startDate, endDate, chunkSizeDays) {
	const chunks = [];
	const startDateObj = new Date(startDate);
	const endDateObj = new Date(endDate);
	let chunkStartDate = new Date(startDateObj);
  
	while (chunkStartDate < endDateObj) {
	  let chunkEndDate = new Date(chunkStartDate);
	  chunkEndDate.setDate(chunkEndDate.getDate() + chunkSizeDays - 1);
	  if (chunkEndDate > endDateObj) {
		chunkEndDate = new Date(endDateObj);
	  }
	  chunks.push({
		start: chunkStartDate.toISOString().split('T')[0],
		end: chunkEndDate.toISOString().split('T')[0],
	  });
	  chunkStartDate = new Date(chunkEndDate);
	  chunkStartDate.setDate(chunkStartDate.getDate() + 1);
	}
	return chunks;
  }  
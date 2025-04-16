/**
 * Cloudflare Worker to proxy NOAA API requests
 * Includes caching, chunking, and retry logic
 */

// Configuration
const config = {
	station: 'GHCND:USW00014755',  // V2 API station format
	dataTypes: ['SNOW', 'SNWD'],    // Data types to retrieve
	startDate: '1948-08-01',        // Historical start date
	baseURL: 'https://www.ncdc.noaa.gov/cdo-web/api/v2/data', // V2 API endpoint
	chunkSize: 365,                 // Days per chunk (larger on server-side)
	retryCount: 3,                  // Max retry attempts per chunk
	cacheTime: 86400,               // Cache lifetime in seconds (24 hours)
  };
  
  // Main fetch handler
  addEventListener('fetch', event => {
	event.respondWith(handleRequest(event.request));
  });
  
  /**
   * Handle the incoming request
   * @param {Request} request - The incoming request
   */
  async function handleRequest(request) {
	// Define CORS headers
	const corsHeaders = {
	  'Access-Control-Allow-Origin': '*',
	  'Access-Control-Allow-Methods': 'GET, OPTIONS',
	  'Access-Control-Allow-Headers': 'Content-Type',
	  'Access-Control-Max-Age': '86400',
	};
	
	// Handle OPTIONS request for CORS preflight
	if (request.method === 'OPTIONS') {
	  return new Response(null, {
		headers: corsHeaders,
		status: 204,
	  });
	}
  
	// Log request to help with debugging
	console.log(`Received ${request.method} request to ${request.url}`);
	
	try {
	  // Check if we have cached data
	  const cachedData = await SNOWFALL_CACHE.get('snowData', { type: 'json' });
	  const cacheTimestamp = await SNOWFALL_CACHE.get('timestamp');
	  
	  // Use cache if it's less than 24 hours old
	  if (cachedData && cacheTimestamp) {
		const cacheAge = Date.now() - parseInt(cacheTimestamp);
		if (cacheAge < config.cacheTime * 1000) {
		  console.log(`Using cached data from ${new Date(parseInt(cacheTimestamp)).toISOString()}`);
		  return new Response(JSON.stringify(cachedData), {
			headers: {
			  'Content-Type': 'application/json',
			  'Cache-Control': `max-age=${config.cacheTime}`,
			  ...corsHeaders
			}
		  });
		} else {
		  console.log('Cache expired, fetching fresh data');
		}
	  } else {
		console.log('No cache found, fetching data from NOAA');
	  }
	  
	  // Calculate endDate as current date
	  const endDate = new Date().toISOString().split('T')[0];
	  
	  // Fetch fresh data
	  console.log(`Fetching data from ${config.startDate} to ${endDate}`);
	  const data = await fetchAllData(config.startDate, endDate);
	  
	  // Cache the data
	  console.log(`Caching ${data.length} records`);
	  await SNOWFALL_CACHE.put('snowData', JSON.stringify(data), { expirationTtl: config.cacheTime });
	  await SNOWFALL_CACHE.put('timestamp', Date.now().toString(), { expirationTtl: config.cacheTime });
	  
	  // Return the response
	  return new Response(JSON.stringify(data), {
		headers: {
		  'Content-Type': 'application/json',
		  'Cache-Control': `max-age=${config.cacheTime}`,
		  ...corsHeaders
		}
	  });
	} catch (error) {
	  // Log error details for debugging
	  console.error(`Error processing request: ${error.message}`);
	  console.error(error.stack);
	  
	  // Return a useful error message
	  return new Response(JSON.stringify({ 
		error: error.message,
		timestamp: new Date().toISOString()
	  }), {
		status: 500,
		headers: {
		  'Content-Type': 'application/json',
		  ...corsHeaders
		}
	  });
	}
  }
  
  /**
   * Fetch data from NOAA API for all data types
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   */
  async function fetchAllData(startDate, endDate) {
	// Create date chunks
	const chunks = createDateChunks(startDate, endDate, config.chunkSize);
	const allResults = new Map();
	
	console.log(`Processing ${chunks.length} chunks for ${config.dataTypes.length} data types`);
	
	// Process each data type
	for (const dataType of config.dataTypes) {
	  // Process each chunk
	  for (const chunk of chunks) {
		console.log(`Fetching ${dataType} from ${chunk.start} to ${chunk.end}`);
		const results = await fetchDataChunk(dataType, chunk.start, chunk.end);
		
		// Process results for this data type
		for (const item of results) {
		  const date = item.date.split('T')[0]; // Extract date part
		  
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
		
		// Add a small delay between chunks to avoid rate limiting
		await new Promise(resolve => setTimeout(resolve, 500));
	  }
	}
	
	// Convert map to array and sort by date
	const combinedResults = Array.from(allResults.values());
	combinedResults.sort((a, b) => a.DATE.localeCompare(b.DATE));
	
	console.log(`Processed ${combinedResults.length} total records`);
	return combinedResults;
  }
  
  /**
   * Fetch data for a specific data type and date range with retries
   * @param {string} dataType - NOAA data type (SNOW, SNWD)
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {number} retryCount - Current retry attempt
   */
  async function fetchDataChunk(dataType, startDate, endDate, retryCount = 0) {
	// If we've exceeded retry count, return empty results
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
	url.searchParams.set('units', 'metric'); // Use metric for mm (to match original API)
	
	try {
	  console.log(`Making request to ${url.toString()}`);
	  
	  const response = await fetch(url, {
		method: 'GET',
		headers: {
		  'token': NOAA_API_TOKEN
		}
	  });
	  
	  if (!response.ok) {
		const responseText = await response.text();
		console.error(`Error response ${response.status}: ${responseText}`);
		
		// Handle rate limiting
		if (response.status === 429 || response.status === 503 || response.status === 403) {
		  // Calculate backoff time based on retry count (exponential backoff)
		  const backoffTime = Math.min(15000, 2000 * Math.pow(1.5, retryCount));
		  console.log(`Rate limited (${response.status}). Waiting ${backoffTime}ms before retry ${retryCount + 1}...`);
		  await new Promise(resolve => setTimeout(resolve, backoffTime));
		  return fetchDataChunk(dataType, startDate, endDate, retryCount + 1);
		}
		
		throw new Error(`HTTP error! status: ${response.status}`);
	  }
	  
	  const data = await response.json();
	  console.log(`Received ${data?.results?.length || 0} ${dataType} records`);
	  return data && data.results ? data.results : [];
	} catch (error) {
	  console.error(`Error fetching ${dataType} from ${startDate} to ${endDate}:`, error);
	  
	  // Calculate backoff time based on retry count
	  const backoffTime = Math.min(15000, 2000 * Math.pow(1.5, retryCount));
	  
	  // Retry on network errors
	  console.log(`Network error. Waiting ${backoffTime}ms before retry ${retryCount + 1}...`);
	  await new Promise(resolve => setTimeout(resolve, backoffTime));
	  return fetchDataChunk(dataType, startDate, endDate, retryCount + 1);
	}
  }
  
  /**
   * Create date chunks for processing
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {number} chunkSizeDays - Size of each chunk in days
   */
  function createDateChunks(startDate, endDate, chunkSizeDays) {
	const chunks = [];
	const startDateObj = new Date(startDate);
	const endDateObj = new Date(endDate);
	
	let chunkStartDate = new Date(startDateObj);
	
	while (chunkStartDate < endDateObj) {
	  let chunkEndDate = new Date(chunkStartDate);
	  chunkEndDate.setDate(chunkEndDate.getDate() + chunkSizeDays - 1); // Inclusive end date
	  
	  // Ensure the chunk doesn't exceed the end date
	  if (chunkEndDate > endDateObj) {
		chunkEndDate = new Date(endDateObj);
	  }
	  
	  chunks.push({
		start: chunkStartDate.toISOString().split('T')[0],
		end: chunkEndDate.toISOString().split('T')[0]
	  });
	  
	  // Move to the next chunk
	  chunkStartDate = new Date(chunkEndDate);
	  chunkStartDate.setDate(chunkStartDate.getDate() + 1);
	}
	
	return chunks;
  }
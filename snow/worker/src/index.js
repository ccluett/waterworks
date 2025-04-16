// Main Worker code (index.js)
export default {
	// Handle HTTP requests - this just returns the cached data
	async fetch(request, env, ctx) {
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
  
	  console.log(`Received ${request.method} request to ${request.url}`);
	  
	  // Parse URL to check for parameters
	  const url = new URL(request.url);
	  const bypassCache = url.searchParams.has('bypass_cache');
	  const adminAction = url.searchParams.get('admin');
	  
	  // Admin actions for manual control (use with ?admin=action)
	  if (adminAction) {
		// Check for a simple admin token/password to prevent unauthorized access
		const adminToken = url.searchParams.get('token');
		if (adminToken !== env.ADMIN_TOKEN) {
		  return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: {
			  'Content-Type': 'application/json',
			  ...corsHeaders,
			}
		  });
		}
  
		if (adminAction === 'clear_cache') {
		  // Clear the cache completely
		  await env.SNOWFALL_CACHE.delete('snowData');
		  await env.SNOWFALL_CACHE.delete('timestamp');
		  await env.SNOWFALL_CACHE.delete('progress');
		  return new Response(JSON.stringify({ success: true, message: "Cache cleared" }), {
			headers: {
			  'Content-Type': 'application/json',
			  ...corsHeaders,
			}
		  });
		}
		else if (adminAction === 'start_fetch') {
		  // Manually trigger a fetch cycle - schedule it to run immediately
		  ctx.waitUntil(queueFetchCycle(env));
		  return new Response(JSON.stringify({ success: true, message: "Fetch cycle queued" }), {
			headers: {
			  'Content-Type': 'application/json',
			  ...corsHeaders,
			}
		  });
		}
		else if (adminAction === 'status') {
		  // Return status information
		  const progress = await env.SNOWFALL_CACHE.get('progress', { type: 'json' }) || {};
		  const timestamp = await env.SNOWFALL_CACHE.get('timestamp');
		  const dataLength = await getDataLength(env);
		  return new Response(JSON.stringify({ 
			progress, 
			lastUpdate: timestamp ? new Date(parseInt(timestamp)).toISOString() : null,
			dataLength
		  }), {
			headers: {
			  'Content-Type': 'application/json',
			  ...corsHeaders,
			}
		  });
		}
	  }
  
	  try {
		// Get cached data
		const cachedData = await env.SNOWFALL_CACHE.get('snowData', { type: 'json' });
		const cacheTimestamp = await env.SNOWFALL_CACHE.get('timestamp');
		
		// If we have data, return it
		if (cachedData && cachedData.length > 0) {
		  console.log(`Returning cached data from ${new Date(parseInt(cacheTimestamp)).toISOString()}`);
		  console.log(`Cached data length: ${cachedData.length} records`);
		  
		  // Return data
		  return new Response(JSON.stringify(cachedData), {
			headers: {
			  'Content-Type': 'application/json',
			  'Cache-Control': `max-age=${config.cacheTime}`,
			  ...corsHeaders,
			},
		  });
		} else {
		  // If no cached data exists yet, trigger an initial fetch
		  ctx.waitUntil(queueFetchCycle(env));
		  
		  // Return an appropriate message
		  return new Response(JSON.stringify({ 
			message: "No data available yet. Initial data fetch has been triggered. Please try again in a few minutes.",
			timestamp: new Date().toISOString()
		  }), {
			status: 503, // Service Unavailable
			headers: {
			  'Content-Type': 'application/json',
			  ...corsHeaders,
			  'Retry-After': '300' // Suggest client retry in 5 minutes
			},
		  });
		}
	  } catch (error) {
		console.error(`Error processing request: ${error.message}`);
		console.error(error.stack);
		return new Response(JSON.stringify({ 
		  error: error.message,
		  timestamp: new Date().toISOString()
		}), {
		  status: 500,
		  headers: {
			'Content-Type': 'application/json',
			...corsHeaders,
		  },
		});
	  }
	},
  
	// Handle scheduled events - this is where data fetching happens
	async scheduled(event, env, ctx) {
	  console.log(`Running scheduled task: ${event.cron}`);
	  
	  // Queue the fetch cycle
	  ctx.waitUntil(queueFetchCycle(env));
	}
  };
  
  // Helper function to get data length
  async function getDataLength(env) {
	try {
	  const data = await env.SNOWFALL_CACHE.get('snowData', { type: 'json' });
	  return data ? data.length : 0;
	} catch (e) {
	  console.error('Error getting data length:', e);
	  return 0;
	}
  }
  
  // Queue a fetch cycle - optimized for one-time fetch
  async function queueFetchCycle(env) {
	try {
	  // Get token
	  const token = env.NOAA_API_TOKEN;
	  if (!token) {
		console.error('NOAA_API_TOKEN is not defined in the environment');
		return;
	  }
	  
	  // Get current date
	  const currentDate = new Date();
	  const endDate = currentDate.toISOString().split('T')[0];
	  
	  console.log(`Starting complete data fetch from ${config.startDate} to ${endDate}`);
	  
	  // Fetch all data in one go
	  const data = await fetchAllData(config.startDate, endDate, token);
	  console.log(`Fetched ${data.length} total records from NOAA`);
  
	  // If we got data, store it
	  if (data.length > 0) {
		console.log(`Caching ${data.length} records`);
		await env.SNOWFALL_CACHE.put('snowData', JSON.stringify(data), { expirationTtl: config.cacheTime * 7 }); // Keep for a week
		await env.SNOWFALL_CACHE.put('timestamp', Date.now().toString(), { expirationTtl: config.cacheTime * 7 });
		
		// Update progress to mark as complete
		const progress = {
		  currentYear: currentDate.getFullYear(),
		  complete: true,
		  lastUpdated: new Date().toISOString(),
		  totalRecords: data.length
		};
		await env.SNOWFALL_CACHE.put('progress', JSON.stringify(progress), { expirationTtl: config.cacheTime * 7 });
	  }
	  
	  console.log(`Complete fetch cycle completed with ${data.length} records`);
	} catch (error) {
	  console.error('Error in fetch cycle:', error);
	}
  }
  
  // Configuration and state settings
  const config = {
	station: 'GHCND:USW00014755', // NOAA V2 station format
	dataTypes: ['SNOW', 'SNWD'],   // Data types to retrieve
	startDate: '1948-08-01',       // Historical start date
	baseURL: 'https://www.ncdc.noaa.gov/cdo-web/api/v2/data', // NOAA API endpoint
	chunkSize: 365,                // Days per chunk (using a larger chunk size on the server)
	retryCount: 3,                 // Maximum retry attempts per chunk
	cacheTime: 86400,              // Cache lifetime in seconds (24 hours)
  };
  
  /**
   * Fetch data for all data types from NOAA API.
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} token - NOAA API token
   */
  async function fetchAllData(startDate, endDate, token) {
	try {
	  // Create date chunks
	  const chunks = createDateChunks(startDate, endDate, config.chunkSize);
	  const allResults = new Map();
	  
	  console.log(`Processing ${chunks.length} chunks for ${config.dataTypes.length} data types`);
	  console.log(`First chunk: ${chunks[0].start} to ${chunks[0].end}`);
	  console.log(`Last chunk: ${chunks[chunks.length-1].start} to ${chunks[chunks.length-1].end}`);
  
	  // Process each data type
	  for (const dataType of config.dataTypes) {
		// Process each chunk
		for (const chunk of chunks) {
		  console.log(`Fetching ${dataType} from ${chunk.start} to ${chunk.end}`);
		  
		  try {
			const results = await fetchDataChunk(dataType, chunk.start, chunk.end, token);
			console.log(`Fetched ${results.length} ${dataType} records for this chunk`);
  
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
		  } catch (chunkError) {
			console.error(`Error processing chunk ${chunk.start} to ${chunk.end}: ${chunkError.message}`);
			// Continue to next chunk instead of failing the entire operation
		  }
		  
		  // Add a small delay between chunks to avoid rate limiting
		  await new Promise(resolve => setTimeout(resolve, 1000)); // Increased to 1 second for safer rate limiting
		}
	  }
	  
	  // Convert map to array and sort by date
	  const combinedResults = Array.from(allResults.values());
	  combinedResults.sort((a, b) => a.DATE.localeCompare(b.DATE));
	  
	  console.log(`Processed ${combinedResults.length} total records`);
	  if (combinedResults.length > 0) {
		console.log(`Sample data - first record: ${JSON.stringify(combinedResults[0])}`);
		console.log(`Sample data - last record: ${JSON.stringify(combinedResults[combinedResults.length-1])}`);
	  } else {
		console.error(`No records found - empty result set`);
	  }
	  
	  return combinedResults;
	} catch (error) {
	  console.error(`Error in fetchAllData: ${error.message}`);
	  console.error(error.stack);
	  return []; // Return empty array so we don't break the application
	}
  }
  
  /**
   * Fetch data for a specific data type and date range with retries.
   * @param {string} dataType - NOAA data type (SNOW, SNWD)
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string} token - NOAA API token from env
   * @param {number} retryCount - Current retry attempt (optional)
   */
  async function fetchDataChunk(dataType, startDate, endDate, token, retryCount = 0) {
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
		  'token': token,
		},
	  });
	  
	  if (!response.ok) {
		const responseText = await response.text();
		console.error(`Error response ${response.status}: ${responseText}`);
		
		// Provide specific error messages for common NOAA API errors
		if (response.status === 400) {
		  console.error('Bad request: Check that station ID and data types are valid');
		} else if (response.status === 401 || response.status === 403) {
		  console.error('Authentication error: NOAA API token may be invalid or expired');
		} else if (response.status === 429) {
		  console.error('Rate limited: Too many requests to the NOAA API');
		} else if (response.status === 503) {
		  console.error('NOAA API service unavailable, may be down for maintenance');
		}
		
		// Handle rate limiting
		if ([429, 503, 403].includes(response.status)) {
		  const backoffTime = Math.min(15000, 2000 * Math.pow(1.5, retryCount));
		  console.log(`Rate limited (${response.status}). Waiting ${backoffTime}ms before retry ${retryCount + 1}...`);
		  await new Promise(resolve => setTimeout(resolve, backoffTime));
		  return fetchDataChunk(dataType, startDate, endDate, token, retryCount + 1);
		}
		
		throw new Error(`HTTP error! status: ${response.status}, response: ${responseText}`);
	  }
	  
	  const data = await response.json();
	  console.log(`Received ${data?.results?.length || 0} ${dataType} records`);
	  
	  if (data?.results?.length === 0) {
		console.warn(`No ${dataType} data available for period ${startDate} to ${endDate}`);
	  }
	  
	  return data && data.results ? data.results : [];
	} catch (error) {
	  console.error(`Error fetching ${dataType} from ${startDate} to ${endDate}:`, error);
	  const backoffTime = Math.min(15000, 2000 * Math.pow(1.5, retryCount));
	  console.log(`Network error. Waiting ${backoffTime}ms before retry ${retryCount + 1}...`);
	  await new Promise(resolve => setTimeout(resolve, backoffTime));
	  return fetchDataChunk(dataType, startDate, endDate, token, retryCount + 1);
	}
  }
  
  /**
   * Create date chunks for processing.
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
		end: chunkEndDate.toISOString().split('T')[0],
	  });
	  
	  // Move to the next chunk
	  chunkStartDate = new Date(chunkEndDate);
	  chunkStartDate.setDate(chunkStartDate.getDate() + 1);
	}
	
	return chunks;
  }
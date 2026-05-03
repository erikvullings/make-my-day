import type { WeatherFetcherConfig, WeatherResult, WeatherData } from './types.js';

const WEATHER_CODES: Record<number, { condition: string; icon: string }> = {
  0: { condition: 'Clear', icon: '☀️' },
  1: { condition: 'Mainly Clear', icon: '🌤️' },
  2: { condition: 'Partly Cloudy', icon: '⛅' },
  3: { condition: 'Overcast', icon: '☁️' },
  45: { condition: 'Fog', icon: '🌫️' },
  48: { condition: 'Fog', icon: '🌫️' },
  51: { condition: 'Drizzle', icon: '🌧️' },
  53: { condition: 'Drizzle', icon: '🌧️' },
  55: { condition: 'Drizzle', icon: '🌧️' },
  61: { condition: 'Rain', icon: '🌧️' },
  63: { condition: 'Rain', icon: '🌧️' },
  65: { condition: 'Rain', icon: '🌧️' },
  71: { condition: 'Snow', icon: '🌨️' },
  73: { condition: 'Snow', icon: '🌨️' },
  75: { condition: 'Snow', icon: '🌨️' },
  77: { condition: 'Snow Grains', icon: '🌨️' },
  80: { condition: 'Rain Showers', icon: '🌦️' },
  81: { condition: 'Rain Showers', icon: '🌦️' },
  82: { condition: 'Rain Showers', icon: '🌦️' },
  85: { condition: 'Snow Showers', icon: '🌨️' },
  86: { condition: 'Snow Showers', icon: '🌨️' },
  95: { condition: 'Thunderstorm', icon: '⛈️' },
  96: { condition: 'Thunderstorm', icon: '⛈️' },
  99: { condition: 'Thunderstorm', icon: '⛈️' }
};

function getWeatherInfo(code: number) {
  return WEATHER_CODES[code] || { condition: 'Unknown', icon: '❓' };
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function getDayName(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

function getWindDirection(degrees: number): string {
  const directions = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  const index = Math.round(degrees / 45) % 8;
  return directions[index];
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

export async function fetchWeather(config: WeatherFetcherConfig): Promise<WeatherResult> {
  const lat = config.latitude ?? 52.3676;
  const lon = config.longitude ?? 4.9041;
  
  const currentUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
  
  const dailyUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&forecast_days=7`;
  
  const [currentRes, dailyRes] = await Promise.all([
    fetch(currentUrl),
    fetch(dailyUrl)
  ]);
  
  if (!currentRes.ok || !dailyRes.ok) {
    throw new Error('Failed to fetch weather data');
  }
  
  const currentData = await currentRes.json();
  const dailyData = await dailyRes.json();
  
  const currentWeather = getWeatherInfo(currentData.current.weather_code);
  
  const windDir = currentData.current.wind_direction_10m;
  const windDirCompass = getWindDirection(windDir);
  
  const current: WeatherData = {
    temp: Math.round(currentData.current.temperature_2m),
    tempUnit: 'C',
    condition: currentWeather.condition,
    icon: currentWeather.icon,
    humidity: currentData.current.relative_humidity_2m,
    wind: Math.round(currentData.current.wind_speed_10m),
    windUnit: 'km/h',
    windDir: windDirCompass,
    location: config.locationName
  };
  
  const daily: WeatherData[] = dailyData.daily.time.map((date: string, i: number) => {
    const weatherInfo = getWeatherInfo(dailyData.daily.weather_code[i]);
    const dayDate = new Date(date);
    
    const tempMin = Math.round(dailyData.daily.temperature_2m_min[i]);
    const tempMax = Math.round(dailyData.daily.temperature_2m_max[i]);
    return {
      date,
      dayName: getDayName(dayDate),
      temp: Math.round((tempMax + tempMin) / 2),
      tempMin,
      tempMax,
      tempUnit: 'C',
      condition: weatherInfo.condition,
      icon: weatherInfo.icon,
      sunrise: formatTime(dailyData.daily.sunrise[i]),
      sunset: formatTime(dailyData.daily.sunset[i])
    };
  });
  
  return { current, daily };
}

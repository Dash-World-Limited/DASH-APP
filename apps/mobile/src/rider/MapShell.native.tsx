/**
 * The native map, on iOS and Android.
 *
 * DASH uses MapLibre rather than Google Maps. Staging uses MapLibre's official
 * demo style so the route can be exercised without a Google account, D-U-N-S,
 * Play Console registration or a Google Maps API key. Production must supply
 * its own OSM-compatible style URL through EXPO_PUBLIC_MAP_STYLE_URL.
 *
 * The Online screen is driven by the rider handset's live foreground GPS and
 * recenters as accepted fixes arrive. Delivery navigation still uses a
 * representative interpolated line until a routing provider is connected;
 * the rider's authoritative position stays the one the server accepted.
 */

import { Camera, GeoJSONSource, Layer, Map, Marker } from '@maplibre/maplibre-react-native';
import { View } from 'react-native';

import { mapStyleUrl } from '../api';
import { useTheme } from '../theme/ThemeProvider';
import { Icon } from '../ui/Icon';
import { MapFallback, type MapShellProps } from './MapFallback';

export type { MapShellProps } from './MapFallback';

export function MapShell(props: MapShellProps) {
  const { palette } = useTheme();
  const {
    route,
    rider,
    destination,
    followRider = false,
    routeColor,
    height = 300,
    destinationIcon = 'silverware-fork-knife',
    accessibilityLabel,
  } = props;

  if (!mapStyleUrl) {
    return <MapFallback {...props} reason="Map style is not configured in this build" />;
  }

  const points = destination ? [rider, ...route, destination] : [rider, ...route];
  const longitudes = points.map((point) => point.longitude);
  const latitudes = points.map((point) => point.latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const padLongitude = Math.max((east - west) * 0.18, 0.0015);
  const padLatitude = Math.max((north - south) * 0.18, 0.0015);

  const routeData = {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'LineString' as const,
      coordinates: route.map((point) => [point.longitude, point.latitude]),
    },
  };

  return (
    <View style={{ height }} accessibilityLabel={accessibilityLabel}>
      <Map
        style={{ flex: 1 }}
        mapStyle={mapStyleUrl}
        androidView="texture"
        compass={false}
        attribution
        attributionPosition={{ bottom: 8, right: 8 }}
      >
        {followRider || !destination ? (
          <Camera
            minZoom={3}
            maxZoom={19}
            center={[rider.longitude, rider.latitude]}
            zoom={15.5}
            duration={650}
            easing="ease"
            padding={{ top: 36, right: 24, bottom: 36, left: 24 }}
          />
        ) : (
          <Camera
            minZoom={3}
            maxZoom={19}
            initialViewState={{
              bounds: [
                west - padLongitude,
                south - padLatitude,
                east + padLongitude,
                north + padLatitude,
              ],
              padding: { top: 54, right: 42, bottom: 54, left: 42 },
            }}
          />
        )}

        {route.length >= 2 ? (
          <GeoJSONSource id="dash-route" data={routeData}>
            <Layer
              id="dash-route-line"
              type="line"
              source="dash-route"
              paint={{ 'line-color': routeColor, 'line-width': 5 }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
          </GeoJSONSource>
        ) : null}

        <Marker id="dash-rider" lngLat={[rider.longitude, rider.latitude]} anchor="center">
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: palette.map.riderMarker,
              borderWidth: 3,
              borderColor: '#FFFFFF',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="moped" size={18} color="#0B0D10" />
          </View>
        </Marker>

        {destination ? (
          <Marker id="dash-destination" lngLat={[destination.longitude, destination.latitude]} anchor="bottom">
            <View style={{ alignItems: 'center' }}>
              <View
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  backgroundColor: palette.map.pickupPin,
                  borderWidth: 3,
                  borderColor: '#FFFFFF',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name={destinationIcon} size={18} color="#FFFFFF" />
              </View>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: '#0B0D10',
                  marginTop: -2,
                }}
              />
            </View>
          </Marker>
        ) : null}
      </Map>
    </View>
  );
}

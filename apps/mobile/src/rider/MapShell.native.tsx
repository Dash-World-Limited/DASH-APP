/**
 * The native map, on iOS and Android.
 *
 * DASH uses MapLibre rather than Google Maps. Development and staging default
 * to OpenFreeMap's Liberty style, so maps work without a Google account or
 * key; production must supply its own OSM-compatible style URL through
 * EXPO_PUBLIC_MAP_STYLE_URL (the production build refuses to configure
 * without one).
 *
 * Everything drawn here is real: the rider marker is the handset's own GPS
 * fix, and the destination is the shop's or the customer's stored position.
 * There is no routing provider, so there is no route. With `directLine` the
 * map draws a dashed straight line rider-to-destination — a bearing, styled
 * so it cannot be mistaken for a road path. Directions are handed to the
 * rider's own navigation app.
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
    rider,
    destination,
    directLine = false,
    followRider = false,
    routeColor,
    height = 300,
    destinationIcon = 'silverware-fork-knife',
    destinationKind = 'pickup',
    accessibilityLabel,
  } = props;

  if (!mapStyleUrl) {
    return <MapFallback {...props} reason="Map style is not configured in this build" />;
  }

  const points = destination ? [rider, destination] : [rider];
  const longitudes = points.map((point) => point.longitude);
  const latitudes = points.map((point) => point.latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const padLongitude = Math.max((east - west) * 0.18, 0.0015);
  const padLatitude = Math.max((north - south) * 0.18, 0.0015);

  const lineData = destination
    ? {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [rider.longitude, rider.latitude],
            [destination.longitude, destination.latitude],
          ],
        },
      }
    : null;

  return (
    <View style={height === 'fill' ? { flex: 1 } : { height }} accessibilityLabel={accessibilityLabel}>
      <Map
        style={{ flex: 1 }}
        mapStyle={mapStyleUrl}
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

        {directLine && lineData ? (
          <GeoJSONSource id="dash-direct-line" data={lineData}>
            <Layer
              id="dash-direct-line-layer"
              type="line"
              source="dash-direct-line"
              paint={{ 'line-color': routeColor, 'line-width': 3, 'line-opacity': 0.85, 'line-dasharray': [1.6, 1.8] }}
              layout={{ 'line-cap': 'round' }}
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
                  backgroundColor: destinationKind === 'dropoff' ? palette.map.dropoffPin : palette.map.pickupPin,
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

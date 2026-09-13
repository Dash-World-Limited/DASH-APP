/**
 * The native map, on iOS and Android.
 *
 * A real platform map — Apple Maps on iOS, Google Maps on Android — not a
 * picture of one and not a web widget. It is a representative shell for this
 * checkpoint: it draws the route, the rider and the destination from
 * coordinates, fits them in view, and is ready to be fed a live position and a
 * routed polyline. Turn-by-turn and live tracking arrive with the Rider
 * operations milestone; the rider's authoritative position stays the one the
 * server accepted, never one this view invents.
 *
 * Android needs a Google Maps key compiled into the build. Without one the
 * platform draws an empty grey surface, so this shows the designed fallback
 * and names what is missing instead.
 */

import { useRef } from 'react';
import { Platform, View } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT, PROVIDER_GOOGLE, Polyline } from 'react-native-maps';

import { mapsConfigured } from '../api';
import { useTheme } from '../theme/ThemeProvider';
import { Icon } from '../ui/Icon';
import { MapFallback, type MapShellProps } from './MapFallback';

export type { MapShellProps } from './MapFallback';

export function MapShell(props: MapShellProps) {
  const { palette, scheme } = useTheme();
  const map = useRef<MapView | null>(null);
  const { route, rider, destination, routeColor, height = 300, destinationIcon = 'silverware-fork-knife', accessibilityLabel } = props;

  if (Platform.OS === 'android' && !mapsConfigured) {
    return <MapFallback {...props} reason="Map needs a Google Maps key in this build" />;
  }

  return (
    <View style={{ height }} accessibilityLabel={accessibilityLabel}>
      <MapView
        ref={map}
        style={{ flex: 1 }}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        userInterfaceStyle={scheme}
        toolbarEnabled={false}
        showsCompass={false}
        pitchEnabled={false}
        initialRegion={{
          latitude: (rider.latitude + destination.latitude) / 2,
          longitude: (rider.longitude + destination.longitude) / 2,
          latitudeDelta: Math.abs(rider.latitude - destination.latitude) * 2.2 + 0.004,
          longitudeDelta: Math.abs(rider.longitude - destination.longitude) * 2.2 + 0.004,
        }}
        onMapReady={() =>
          map.current?.fitToCoordinates([rider, ...route, destination], {
            edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
            animated: false,
          })
        }
      >
        <Polyline coordinates={[...route]} strokeColor={routeColor} strokeWidth={5} lineCap="round" lineJoin="round" />
        <Marker coordinate={rider} anchor={{ x: 0.5, y: 0.5 }} title="You" tracksViewChanges={false}>
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
        <Marker coordinate={destination} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}>
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
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#0B0D10', marginTop: -2 }} />
          </View>
        </Marker>
      </MapView>
    </View>
  );
}

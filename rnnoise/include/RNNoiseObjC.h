#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

__attribute__((visibility("default")))
@interface RNNoiseWrapper : NSObject

- (instancetype)init;

- (void)dealloc;

/**
 * Initialize RNNoiseWrapper with the sample rate and number of channels.
 *
 * @param sampleRateHz The sample rate in Hz.
 * @param channels The number of channels.
 *
 */
- (BOOL)initialize:(int)sampleRateHz numChannels:(int)channels;

/**
 * Process the audio buffer.
 *
 * @param bands The number of frequency bands.
 * @param frames The number of frames.
 * @param bufferSize The size of the buffer.
 * @param buffer The audio buffer.
 *
 */
- (float)processWithBands:(int)bands
                   frames:(int)frames
               bufferSize:(int)bufferSize
                   buffer:(float *)buffer;

@end

NS_ASSUME_NONNULL_END

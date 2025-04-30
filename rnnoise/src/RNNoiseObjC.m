#import "RNNoiseObjC.h"
#import "rnnoise.h"

@interface RNNoiseWrapper ()
@property(nonatomic, assign) DenoiseState *denoiseState;
@property(nonatomic, assign) int supportSampleRateHz;
@property(nonatomic, assign) int supportNumChannels;
@end

@implementation RNNoiseWrapper

- (instancetype)init {
    self = [super init];
    if (self) {
        _supportSampleRateHz = 48000;
        _supportNumChannels = 1;
        _denoiseState = NULL;
    }
    return self;
}

- (void)dealloc {
    [self uninitialize];

#if !__has_feature(objc_arc)
    [super dealloc]; // Call [super dealloc] if ARC is not enabled
#endif
}

- (BOOL)initialize:(int)sampleRateHz numChannels:(int)channels {
    if (_denoiseState) {
        return YES;
    }

    if (sampleRateHz != _supportSampleRateHz ||
        channels != _supportNumChannels) {
        return NO;
    }

    _denoiseState = rnnoise_create(NULL);

    return _denoiseState != NULL;
}

- (float)processWithBands:(int)bands
                   frames:(int)frames
               bufferSize:(int)bufferSize
                   buffer:(float *)buffer {
    if (!_denoiseState) {
        return .0f;
    }

    return rnnoise_process_frame(_denoiseState, buffer, buffer);
}

- (void)uninitialize {
    if (_denoiseState) {
        rnnoise_destroy(_denoiseState);
        _denoiseState = NULL;
    }
}

@end

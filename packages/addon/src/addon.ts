import {
  BaseWrapper,
  getCometStreams,
  getEasynewsPlusStreams,
  getEasynewsStreams,
  getMediafusionStreams,
  getTorboxStreams,
  getTorrentioStreams,
} from '@aiostreams/wrappers';
import {
  Stream,
  ParsedStream,
  StreamRequest,
  Config,
  CollectedParsedStreams,
} from '@aiostreams/types';
import {
  gdriveFormat,
  torrentioFormat,
  torboxFormat,
} from '@aiostreams/formatters';
import { createProxiedMediaFlowUrl, Settings } from '@aiostreams/utils';

export class AIOStreams {
  private config: Config;

  constructor(config: any) {
    this.config = config;
  }

  public async getStreams(streamRequest: StreamRequest): Promise<Stream[]> {
    const streams: Stream[] = [];
    const startTime = new Date().getTime();
    const getTimeTakenSincePoint = (point: number) => {
      const timeNow = new Date().getTime();
      const duration = timeNow - point;
      // format duration and choose unit and return
      const nanos = duration * 1_000_000; // Convert to nanoseconds
      const micros = duration * 1_000; // Convert to microseconds

      if (nanos < 1) {
        return `${nanos.toFixed(2)}ns`;
      } else if (micros < 1) {
        return `${micros.toFixed(2)}µs`;
      } else if (duration < 1000) {
        return `${duration.toFixed(2)}ms`;
      } else {
        return `${(duration / 1000).toFixed(2)}s`;
      }
    };
    const parsedStreams = await this.getParsedStreams(streamRequest);
    console.log(
      `|INF| addon > getStreams: Got ${parsedStreams.length} total parsed streams in ${getTimeTakenSincePoint(startTime)}`
    );
    const filterStartTime = new Date().getTime();

    let filteredResults = parsedStreams.filter((parsedStream) => {
      const resolutionFilter = this.config.resolutions.find(
        (resolution) => resolution[parsedStream.resolution]
      );
      if (!resolutionFilter) return false;

      const qualityFilter = this.config.qualities.find(
        (quality) => quality[parsedStream.quality]
      );
      if (!qualityFilter) return false;

      // Check for HDR and DV tags in the parsed stream
      const hasHDR = parsedStream.visualTags.some((tag) =>
        tag.startsWith('HDR')
      );
      const hasDV = parsedStream.visualTags.includes('DV');
      const hasHDRAndDV = hasHDR && hasDV;
      const HDRAndDVEnabled = this.config.visualTags.some(
        (visualTag) => visualTag['HDR+DV'] === true
      );

      // Helper function to check if a specific tag is enabled
      const isTagEnabled = (tag: string) =>
        this.config.visualTags.some((visualTag) => visualTag[tag] === true);

      if (hasHDRAndDV) {
        if (!HDRAndDVEnabled) {
          return false;
        }
      } else if (hasHDR) {
        const specificHdrTags = parsedStream.visualTags.filter((tag) =>
          tag.startsWith('HDR')
        );
        const disabledTags = specificHdrTags.filter(
          (tag) => !isTagEnabled(tag)
        );
        if (disabledTags.length > 0) {
          return false;
        }
      } else if (hasDV && !isTagEnabled('DV')) {
        return false;
      }

      // Check other visual tags for explicit disabling
      for (const tag of parsedStream.visualTags) {
        if (tag.startsWith('HDR') || tag === 'DV') continue;
        if (isTagEnabled(tag) === false) {
          return false;
        }
      }

      // apply excludedLanguages filter
      const excludedLanguages = this.config.excludedLanguages;
      if (excludedLanguages && parsedStream.languages.length > 0) {
        if (
          parsedStream.languages.every((lang) =>
            excludedLanguages.includes(lang)
          )
        ) {
          return false;
        }
      }

      const audioTagFilter = parsedStream.audioTags.find(
        (tag) => !this.config.audioTags.some((audioTag) => audioTag[tag])
      );
      if (audioTagFilter) return false;

      if (
        parsedStream.encode &&
        !this.config.encodes.some((encode) => encode[parsedStream.encode])
      )
        return false;

      if (
        this.config.onlyShowCachedStreams &&
        parsedStream.provider &&
        !parsedStream.provider.cached
      )
        return false;

      if (
        this.config.minSize &&
        parsedStream.size &&
        parsedStream.size < this.config.minSize
      )
        return false;

      if (
        this.config.maxSize &&
        parsedStream.size &&
        parsedStream.size > this.config.maxSize
      )
        return false;

      if (
        streamRequest.type === 'movie' &&
        this.config.maxMovieSize &&
        parsedStream.size &&
        parsedStream.size > this.config.maxMovieSize
      )
        return false;

      if (
        streamRequest.type === 'movie' &&
        this.config.minMovieSize &&
        parsedStream.size &&
        parsedStream.size < this.config.minMovieSize
      )
        return false;

      if (
        streamRequest.type === 'series' &&
        this.config.maxEpisodeSize &&
        parsedStream.size &&
        parsedStream.size > this.config.maxEpisodeSize
      )
        return false;

      if (
        streamRequest.type === 'series' &&
        this.config.minEpisodeSize &&
        parsedStream.size &&
        parsedStream.size < this.config.minEpisodeSize
      )
        return false;

      return true;
    });

    console.log(
      `|INF| addon > getStreams: Initial filter to ${filteredResults.length} streams in ${getTimeTakenSincePoint(filterStartTime)}`
    );

    if (this.config.cleanResults) {
      const cleanResultsStartTime = new Date().getTime();
      const uniqueStreams: ParsedStream[] = [];

      // Group streams by normalized filename
      const streamsByHashOrName = filteredResults.reduce(
        (acc, stream) => {
          const normalizedFilename = stream.filename
            ? stream.filename.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
            : undefined;
          const key = stream._infoHash || normalizedFilename;

          if (!key) {
            uniqueStreams.push(stream);
            return acc;
          }

          acc[key] = acc[key] || [];
          acc[key].push(stream);
          return acc;
        },
        {} as Record<string, ParsedStream[]>
      );

      Object.values(streamsByHashOrName).forEach((groupedStreams) => {
        if (groupedStreams.length === 1) {
          uniqueStreams.push(groupedStreams[0]);
          return;
        }
        //console.log(`==================\nDetermining unique streams for ${groupedStreams[0].filename} from ${groupedStreams.length} total duplicates`);
        //console.log(groupedStreams.map(stream => `Addon ID: ${stream.addon.id}, Provider ID: ${stream.provider?.id}, Provider Cached: ${stream.provider?.cached}`));
        // Separate streams into categories
        const cachedStreams = groupedStreams.filter(
          (stream) => stream.provider?.cached
        );
        const uncachedStreams = groupedStreams.filter(
          (stream) => stream.provider && !stream.provider.cached
        );
        const noProviderStreams = groupedStreams.filter(
          (stream) => !stream.provider
        );

        // Select uncached streams by addon priority (one per provider)
        const selectedUncachedStreams = Object.values(
          uncachedStreams.reduce(
            (acc, stream) => {
              acc[stream.provider!.id] = acc[stream.provider!.id] || [];
              acc[stream.provider!.id].push(stream);
              return acc;
            },
            {} as Record<string, ParsedStream[]>
          )
        ).map((providerGroup) => {
          return providerGroup.sort((a, b) => {
            const aIndex = this.config.addons.findIndex(
              (addon) =>
                `${addon.id}-${JSON.stringify(addon.options)}` === a.addon.id
            );
            const bIndex = this.config.addons.findIndex(
              (addon) =>
                `${addon.id}-${JSON.stringify(addon.options)}` === b.addon.id
            );
            return aIndex - bIndex;
          })[0];
        });
        //selectedUncachedStreams.forEach(stream => console.log(`Selected uncached stream for provider ${stream.provider!.id}: Addon ID: ${stream.addon.id}`));

        // Select cached streams by provider and addon priority
        const selectedCachedStream = cachedStreams.sort((a, b) => {
          const aProviderIndex = this.config.services.findIndex(
            (service) => service.id === a.provider!.id
          );
          const bProviderIndex = this.config.services.findIndex(
            (service) => service.id === b.provider!.id
          );

          if (aProviderIndex !== bProviderIndex) {
            return aProviderIndex - bProviderIndex;
          }

          const aAddonIndex = this.config.addons.findIndex(
            (addon) =>
              `${addon.id}-${JSON.stringify(addon.options)}` === a.addon.id
          );
          const bAddonIndex = this.config.addons.findIndex(
            (addon) =>
              `${addon.id}-${JSON.stringify(addon.options)}` === b.addon.id
          );

          return aAddonIndex - bAddonIndex;
        })[0];
        // Select one non-provider stream (highest addon priority)
        const selectedNoProviderStream = noProviderStreams.sort((a, b) => {
          const aIndex = this.config.addons.findIndex(
            (addon) =>
              `${addon.id}-${JSON.stringify(addon.options)}` === a.addon.id
          );
          const bIndex = this.config.addons.findIndex(
            (addon) =>
              `${addon.id}-${JSON.stringify(addon.options)}` === b.addon.id
          );
          return aIndex - bIndex;
        })[0];

        // Combine selected streams for this group
        if (selectedNoProviderStream) {
          //console.log(`Selected no provider stream: Addon ID: ${selectedNoProviderStream.addon.id}`);
          uniqueStreams.push(selectedNoProviderStream);
        }
        if (selectedCachedStream) {
          //console.log(`Selected cached stream for provider ${selectedCachedStream.provider!.id} from Addon ID: ${selectedCachedStream.addon.id}`);
          uniqueStreams.push(selectedCachedStream);
        }
        uniqueStreams.push(...selectedUncachedStreams);
      });

      filteredResults = uniqueStreams;
      console.log(
        `|INF| addon > getStreams: Cleaned results to ${filteredResults.length} streams in ${getTimeTakenSincePoint(cleanResultsStartTime)}`
      );
    }
    // Apply sorting
    const sortStartTime = new Date().getTime();
    // initially sort by filename to ensure consistent results
    filteredResults.sort((a, b) =>
      a.filename && b.filename ? a.filename.localeCompare(b.filename) : 0
    );

    // then apply our this.config sorting
    filteredResults.sort((a, b) => {
      for (const sortByField of this.config.sortBy) {
        const field = Object.keys(sortByField)[0];
        const value = sortByField[field];

        if (value) {
          const fieldComparison = this.compareByField(a, b, field);
          if (fieldComparison !== 0) return fieldComparison;
        }
      }

      return 0;
    });

    console.log(
      `|INF| addon > getStreams: Sorted results in ${getTimeTakenSincePoint(sortStartTime)}`
    );

    // apply config.maxResultsPerResolution
    if (this.config.maxResultsPerResolution) {
      const startTime = new Date().getTime();
      const streamsByResolution = filteredResults.reduce(
        (acc, stream) => {
          acc[stream.resolution] = acc[stream.resolution] || [];
          acc[stream.resolution].push(stream);
          return acc;
        },
        {} as Record<string, ParsedStream[]>
      );

      const limitedStreams = Object.values(streamsByResolution).map(
        (streams) => {
          return streams.slice(0, this.config.maxResultsPerResolution!);
        }
      );

      filteredResults = limitedStreams.flat();
      console.log(
        `|INF| addon > getStreams: Limited results to ${filteredResults.length} streams after applying maxResultsPerResolution in ${getTimeTakenSincePoint(startTime)}`
      );
    }

    // Create stream objects
    const streamsStartTime = new Date().getTime();
    const streamObjects = await Promise.all(
      filteredResults.map(this.createStreamObject.bind(this))
    );
    streams.push(...streamObjects.filter((s) => s !== null));

    console.log(
      `|INF| addon > getStreams: Created ${streams.length} stream objects in ${getTimeTakenSincePoint(streamsStartTime)}`
    );
    console.log(
      `|INF| addon > getStreams: Total time taken to serve streams: ${getTimeTakenSincePoint(startTime)}`
    );
    return streams;
  }

  private createMediaFlowStream(
    parsedStream: ParsedStream,
    name: string,
    description: string
  ): Stream {
    if (!parsedStream.url) {
      console.error(
        `|ERR| addon > createMediaFlowStream: Stream URL is missing, cannot proxy a stream without a URL`
      );
      throw new Error('Stream URL is missing');
    }
    const proxiedUrl = createProxiedMediaFlowUrl(
      parsedStream.url,
      this.config.mediaFlowConfig,
      parsedStream.stream?.behaviorHints?.proxyHeaders
    );
    if (!proxiedUrl) {
      throw new Error('Could not create MediaFlow proxied URL');
    }
    const combinedTags = [
      parsedStream.resolution,
      parsedStream.quality,
      parsedStream.encode,
      ...parsedStream.visualTags,
      ...parsedStream.audioTags,
      ...parsedStream.languages,
    ];

    return {
      url: proxiedUrl,
      name: this.config.addonNameInDescription
        ? Settings.ADDON_NAME
        : `🕵️ ${name}`,
      description: this.config.addonNameInDescription
        ? `🕵️ ${name}\n${description}`
        : description,
      subtitles: parsedStream.stream?.subtitles,
      behaviorHints: {
        notWebReady: parsedStream.stream?.behaviorHints?.notWebReady,
        filename: parsedStream.filename,
        videoSize: Math.floor(parsedStream.size || 0) || undefined,
        videoHash: parsedStream.stream?.behaviorHints?.videoHash,
        bingeGroup: `mfp.${Settings.ADDON_ID}|${parsedStream.addon.name}|${combinedTags.join('|')}`,
      },
    };
  }

  private async createStreamObject(
    parsedStream: ParsedStream
  ): Promise<Stream | null> {
    let name: string = '';
    let description: string = '';
    switch (this.config.formatter) {
      case 'gdrive': {
        const { name: _name, description: _description } =
          gdriveFormat(parsedStream);
        name = _name;
        description = _description;
        break;
      }
      case 'torrentio': {
        const { name: _name, description: _description } =
          torrentioFormat(parsedStream);
        name = _name;
        description = _description;
        break;
      }
      case 'torbox': {
        const { name: _name, description: _description } =
          torboxFormat(parsedStream);
        name = _name;
        description = _description;
        break;
      }
      default: {
        throw new Error('Unsupported formatter');
      }
    }

    const combinedTags = [
      parsedStream.resolution,
      parsedStream.quality,
      parsedStream.encode,
      ...parsedStream.visualTags,
      ...parsedStream.audioTags,
      ...parsedStream.languages,
    ];

    let stream: Stream;

    if (this.config.mediaFlowConfig?.mediaFlowEnabled && parsedStream.url) {
      try {
        const mediaFlowStream = this.createMediaFlowStream(
          parsedStream,
          name,
          description
        );
        if (!mediaFlowStream) {
          throw new Error('Unknown error creating MediaFlow stream');
        }
        return mediaFlowStream;
      } catch (error) {
        console.error(`Failed to create MediaFlow stream URL: ${error}`);
        return null;
      }
    }

    stream = {
      url: parsedStream.url,
      externalUrl: parsedStream.externalUrl,
      infoHash: parsedStream.torrent?.infoHash,
      fileIdx: parsedStream.torrent?.fileIdx,
      name: this.config.addonNameInDescription
        ? Settings.ADDON_NAME
        : Settings.SHOW_DIE
          ? `🎲 ${name}`
          : name,
      description: this.config.addonNameInDescription
        ? `🎲 ${name}\n${description}`
        : description,
      subtitles: parsedStream.stream?.subtitles,
      sources: parsedStream.torrent?.sources,
      behaviorHints: {
        videoSize: Math.floor(parsedStream.size || 0) || undefined,
        filename: parsedStream.filename,
        bingeGroup: `${Settings.ADDON_ID}|${parsedStream.addon.name}|${combinedTags.join('|')}`,
        proxyHeaders: parsedStream.stream?.behaviorHints?.proxyHeaders,
        notWebReady: parsedStream.stream?.behaviorHints?.notWebReady,
      },
    };

    return stream;
  }

  private compareLanguages(a: ParsedStream, b: ParsedStream) {
    if (this.config.prioritiseLanguage) {
      const aHasPrioritisedLanguage = a.languages.includes(
        this.config.prioritiseLanguage
      );
      const bHasPrioritisedLanguage = b.languages.includes(
        this.config.prioritiseLanguage
      );

      if (aHasPrioritisedLanguage && !bHasPrioritisedLanguage) return -1;
      if (!aHasPrioritisedLanguage && bHasPrioritisedLanguage) return 1;
    }
    return 0;
  }

  private compareByField(a: ParsedStream, b: ParsedStream, field: string) {
    if (field === 'resolution') {
      return (
        this.config.resolutions.findIndex(
          (resolution) => resolution[a.resolution]
        ) -
        this.config.resolutions.findIndex(
          (resolution) => resolution[b.resolution]
        )
      );
    } else if (field === 'cached') {
      let aCanbeCached = a.provider;
      let bCanbeCached = b.provider;
      let aCached = a.provider?.cached;
      let bCached = b.provider?.cached;

      // prioritise non debrid/usenet p2p over uncached
      if (aCanbeCached && !bCanbeCached && !aCached) return 1;
      if (!aCanbeCached && bCanbeCached && !bCached) return -1;
      if (aCanbeCached && bCanbeCached) {
        if (aCached === bCached) return 0;
        // prioritise a false value over undefined
        if (aCached === false && bCached === undefined) return -1;
        if (aCached === undefined && bCached === false) return 1;
        return this.config.sortBy.find(
          (sort) => Object.keys(sort)[0] === 'cached'
        )?.direction === 'asc'
          ? aCached
            ? 1
            : -1 // uncached > cached
          : aCached
            ? -1
            : 1; // cached > uncached
      }
    } else if (field === 'hasProvider') {
      // files from a provider should be prioritised and then
      let aHasProvider = a.provider;
      let bHasProvider = b.provider;
      if (aHasProvider && !bHasProvider) return -1;
      if (!aHasProvider && bHasProvider) return 1;
    } else if (field === 'service') {
      // sort files with providers by name
      let aProvider = a.provider?.id;
      let bProvider = b.provider?.id;

      if (aProvider && bProvider) {
        const aIndex = this.config.services.findIndex(
          (service) => service.id === aProvider
        );
        const bIndex = this.config.services.findIndex(
          (service) => service.id === bProvider
        );
        return aIndex - bIndex;
      }
    } else if (field === 'size') {
      return this.config.sortBy.find((sort) => Object.keys(sort)[0] === 'size')
        ?.direction === 'asc'
        ? (a.size || 0) - (b.size || 0)
        : (b.size || 0) - (a.size || 0);
    } else if (field === 'seeders') {
      if (
        a.torrent?.seeders !== undefined &&
        b.torrent?.seeders !== undefined
      ) {
        return this.config.sortBy.find(
          (sort) => Object.keys(sort)[0] === 'seeders'
        )?.direction === 'asc'
          ? a.torrent.seeders - b.torrent.seeders
          : b.torrent.seeders - a.torrent.seeders;
      } else if (
        a.torrent?.seeders !== undefined &&
        b.torrent?.seeders === undefined
      ) {
        return -1;
      } else if (
        a.torrent?.seeders === undefined &&
        b.torrent?.seeders !== undefined
      ) {
        return 1;
      }
    } else if (field === 'quality') {
      return (
        this.config.qualities.findIndex((quality) => quality[a.quality]) -
        this.config.qualities.findIndex((quality) => quality[b.quality])
      );
    } else if (field === 'visualTag') {
      // Find the highest priority visual tag in each file
      const getIndexOfTag = (tag: string) =>
        this.config.visualTags.findIndex((t) => t[tag]);

      const getHighestPriorityTagIndex = (tags: string[]) => {
        // Check if the file contains both any HDR tag and DV
        const hasHDR = tags.some((tag) => tag.startsWith('HDR'));
        const hasDV = tags.includes('DV');

        if (hasHDR && hasDV) {
          // Sort according to the position of the HDR+DV tag
          const hdrDvIndex = this.config.visualTags.findIndex(
            (t) => t['HDR+DV']
          );
          if (hdrDvIndex !== -1) {
            return hdrDvIndex;
          }
        }

        // If the file contains multiple HDR tags, look at the HDR tag that has the highest priority
        const hdrTagIndices = tags
          .filter((tag) => tag.startsWith('HDR'))
          .map((tag) => getIndexOfTag(tag));
        if (hdrTagIndices.length > 0) {
          return Math.min(...hdrTagIndices);
        }

        // Always consider the highest priority visual tag when a file has multiple visual tags
        return tags.reduce(
          (minIndex, tag) => Math.min(minIndex, getIndexOfTag(tag)),
          this.config.visualTags.length
        );
      };

      const aVisualTagIndex = getHighestPriorityTagIndex(a.visualTags);
      const bVisualTagIndex = getHighestPriorityTagIndex(b.visualTags);

      // Sort by the visual tag index
      return aVisualTagIndex - bVisualTagIndex;
    } else if (field === 'audioTag') {
      // Find the highest priority audio tag in each file
      const getIndexOfTag = (tag: string) =>
        this.config.audioTags.findIndex((t) => t[tag]);
      const aAudioTagIndex = a.audioTags.reduce(
        (minIndex, tag) => Math.min(minIndex, getIndexOfTag(tag)),
        this.config.audioTags.length
      );

      const bAudioTagIndex = b.audioTags.reduce(
        (minIndex, tag) => Math.min(minIndex, getIndexOfTag(tag)),
        this.config.audioTags.length
      );
      // Sort by the audio tag index
      return aAudioTagIndex - bAudioTagIndex;
    } else if (field === 'encode') {
      return (
        this.config.encodes.findIndex((encode) => encode[a.encode]) -
        this.config.encodes.findIndex((encode) => encode[b.encode])
      );
    } else if (field === 'addon') {
      const aAddon = a.addon.id;
      const bAddon = b.addon.id;

      const addonIds = this.config.addons.map((addon) => {
        return `${addon.id}-${JSON.stringify(addon.options)}`;
      });
      return addonIds.indexOf(aAddon) - addonIds.indexOf(bAddon);
    } else if (field === 'language') {
      if (this.config.prioritiseLanguage) {
        return this.compareLanguages(a, b);
      }
      if (!this.config.prioritisedLanguages) {
        return 0;
      }
      // else, we look at the array of prioritisedLanguages.
      // any file with a language in the prioritisedLanguages array should be prioritised
      // if both files contain a prioritisedLanguage, we compare the index of the highest priority language

      const aHasPrioritisedLanguage = a.languages.some((lang) =>
        this.config.prioritisedLanguages?.includes(lang)
      );
      const bHasPrioritisedLanguage = b.languages.some((lang) =>
        this.config.prioritisedLanguages?.includes(lang)
      );

      if (aHasPrioritisedLanguage && !bHasPrioritisedLanguage) return -1;
      if (!aHasPrioritisedLanguage && bHasPrioritisedLanguage) return 1;

      if (aHasPrioritisedLanguage && bHasPrioritisedLanguage) {
        const getHighestPriorityLanguageIndex = (languages: string[]) => {
          return languages.reduce((minIndex, lang) => {
            const index =
              this.config.prioritisedLanguages?.indexOf(lang) ??
              this.config.prioritisedLanguages!.length;
            return index !== -1 ? Math.min(minIndex, index) : minIndex;
          }, this.config.prioritisedLanguages!.length);
        };

        const aHighestPriorityLanguageIndex = getHighestPriorityLanguageIndex(
          a.languages
        );
        const bHighestPriorityLanguageIndex = getHighestPriorityLanguageIndex(
          b.languages
        );

        return aHighestPriorityLanguageIndex - bHighestPriorityLanguageIndex;
      }
    }
    return 0;
  }

  private async getParsedStreams(
    streamRequest: StreamRequest
  ): Promise<ParsedStream[]> {
    const parsedStreams: ParsedStream[] = [];
    const addonPromises = this.config.addons.map(async (addon) => {
      const addonName =
        addon.options.name || addon.options.overrideName || addon.id;
      try {
        const addonId = `${addon.id}-${JSON.stringify(addon.options)}`;
        const streams = await this.getStreamsFromAddon(
          addon,
          addonId,
          streamRequest
        );
        parsedStreams.push(...streams);
        console.log(
          `|INF| addon > getParsedStreams: Got ${streams.length} streams from addon ${addonName}`
        );
      } catch (error) {
        console.error(
          `|ERR| addon > getParsedStreams: Failed to get streams from ${addonName}: ${error}`
        );
      }
    });

    await Promise.all(addonPromises);
    return parsedStreams;
  }

  private async getStreamsFromAddon(
    addon: Config['addons'][0],
    addonId: string,
    streamRequest: StreamRequest
  ): Promise<ParsedStream[]> {
    switch (addon.id) {
      case 'torbox': {
        return await getTorboxStreams(
          this.config,
          addon.options,
          streamRequest,
          addonId
        );
      }
      case 'torrentio': {
        return await getTorrentioStreams(
          this.config,
          addon.options,
          streamRequest,
          addonId
        );
      }
      case 'comet': {
        return await getCometStreams(
          this.config,
          addon.options,
          streamRequest,
          addonId
        );
      }
      case 'mediafusion': {
        return await getMediafusionStreams(
          this.config,
          addon.options,
          streamRequest,
          addonId
        );
      }
      case 'easynews': {
        return await getEasynewsStreams(
          this.config,
          addon.options,
          streamRequest,
          addonId
        );
      }
      case 'easynews-plus': {
        return await getEasynewsPlusStreams(
          this.config,
          addon.options,
          streamRequest,
          addonId
        );
      }
      case 'gdrive': {
        if (!addon.options.addonUrl) {
          throw new Error('The addon URL was undefined for GDrive');
        }
        const wrapper = new BaseWrapper(
          addon.options.overrideName || 'GDrive',
          addon.options.addonUrl,
          addon.options.indexerTimeout
            ? parseInt(addon.options.indexerTimeout)
            : undefined,
          addonId,
          this.config
        );
        return await wrapper.getParsedStreams(streamRequest);
      }
      default: {
        if (!addon.options.url) {
          throw new Error(
            `The addon URL was undefined for ${addon.options.name}`
          );
        }
        const wrapper = new BaseWrapper(
          addon.options.name || 'Custom',
          addon.options.url.trim(),
          addon.options.indexerTimeout
            ? parseInt(addon.options.indexerTimeout)
            : undefined,
          addonId,
          this.config
        );
        return await wrapper.getParsedStreams(streamRequest);
      }
    }
  }
}

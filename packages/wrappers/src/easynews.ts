import { AddonDetail, ParsedNameData, StreamRequest } from '@aiostreams/types';
import {
  parseFilename,
  extractSizeInBytes,
  extractDurationInMs,
} from '@aiostreams/parser';
import { ParsedStream, Stream, Config } from '@aiostreams/types';
import { BaseWrapper } from './base';
import { addonDetails, serviceDetails } from '@aiostreams/utils';
import { Settings } from '@aiostreams/utils';

export class Easynews extends BaseWrapper {
  constructor(
    configString: string | null,
    overrideUrl: string | null,
    indexerTimeout: number = Settings.DEFAULT_EASYNEWS_TIMEMOUT,
    addonName: string = 'Easynews',
    addonId: string,
    userConfig: Config
  ) {
    let url = overrideUrl
      ? overrideUrl
      : Settings.EASYNEWS_URL + (configString ? configString + '/' : '');

    super(addonName, url, indexerTimeout, addonId, userConfig);
  }

  protected parseStream(stream: Stream): ParsedStream {
    const [filename, sizeString, durationString] =
      stream.description?.split('\n') || [];

    const parsedFilename: ParsedNameData = parseFilename(
      filename || stream.description || ''
    );
    const sizeInBytes = stream.description
      ? extractSizeInBytes(sizeString, 1024)
      : undefined;

    const provider = {
      id: 'easynews',
      cached: true,
    };

    const durationInMs = extractDurationInMs(durationString || '');

    const parsedStream: ParsedStream = this.createParsedResult(
      parsedFilename,
      stream,
      filename,
      sizeInBytes,
      provider,
      undefined,
      undefined,
      undefined,
      durationInMs
    );
    return parsedStream;
  }
}

const getEasynewsConfigString = (username: string, password: string) => {
  return `%7B%22username%22%3A%22${username}%22%2C%22password%22%3A%22${password}%22%7D`;
};

export async function getEasynewsStreams(
  config: Config,
  easynewsOptions: {
    overrideName?: string;
    overrideUrl?: string;
    indexerTimeout?: string;
  },
  streamRequest: StreamRequest,
  addonId: string
): Promise<ParsedStream[]> {
  // look for the 'easynews' id in the services array and destructure the username and password
  // if we cant find it, throw an error
  const easynewsService = serviceDetails.find(
    (service) => service.id === 'easynews'
  );
  if (!easynewsService) {
    throw new Error('Easynews service not found');
  }

  // check for the presence of the username and password in teh easynewsService.credentials object
  // if not found, throw an error
  const credentails = config.services.find(
    (service) => service.id === 'easynews'
  )?.credentials;
  if (!credentails || !credentails.username || !credentails.password) {
    throw new Error('Easynews credentials not found');
  }

  const easynewsConfigString = getEasynewsConfigString(
    credentails.username,
    credentails.password
  );

  const easynews = new Easynews(
    easynewsConfigString,
    easynewsOptions.overrideUrl ?? null,
    easynewsOptions.indexerTimeout
      ? parseInt(easynewsOptions.indexerTimeout)
      : undefined,
    easynewsOptions.overrideName,
    addonId,
    config
  );

  const streams = await easynews.getParsedStreams(streamRequest);
  return streams;
}
